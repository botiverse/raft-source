import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, channels, mentionDeliveryOccurrences, messageMentions, messages, servers, users } from "../db/schema.js";
import {
  claimMentionDeliveryRedrive,
  ensureMentionDeliveryOccurrences,
  evaluateMentionDeliveryOccurrence,
  getMentionDeliveryOccurrence,
  listRecoverableMentionDeliveries,
  lookupMentionDeliveryOccurrence,
  recordMentionDeliveryAck,
  recordMentionDeliveryDaemonTransition,
  recordMentionDeliveryServerDecision,
  type MentionDeliveryLookupResult,
  type MentionDeliveryOccurrenceRow,
} from "./mentionDeliveryOccurrenceService.js";


const at = new Date("2026-08-16T00:00:00.000Z");

afterEach(async () => {
  await closeTestDatabase();
});

function ackedBusyOccurrence(): MentionDeliveryOccurrenceRow {
  return {
    occurrenceId: "00000000-0000-4000-8000-000000000001",
    messageId: "00000000-0000-4000-8000-000000000002",
    serverId: "00000000-0000-4000-8000-000000000003",
    agentId: "00000000-0000-4000-8000-000000000004",
    deliveryPayload: null,
    state: "acked",
    deliveryPath: "busy",
    machineIdSnapshot: "00000000-0000-4000-8000-000000000005",
    launchIdSnapshot: "launch-1",
    sessionIdSnapshot: "session-1",
    mentionRecordedAt: at,
    serverDecidedAt: at,
    daemonReceivedAt: at,
    daemonPendingAt: at,
    daemonDrainedAt: at,
    ackedAt: at,
    terminalErrorAt: null,
    terminalErrorCode: null,
    pendingCoalescedCount: 0,
    version: 5,
    redriveCount: 0,
    lastRedriveAt: null,
    createdAt: at,
    updatedAt: at,
  };
}

test("every claimed transition without its receipt is INSTRUMENT_FAILED", () => {
  const cases: Array<{
    receipt: keyof MentionDeliveryOccurrenceRow;
    missingReceipt: "MENTION_RECORDED" | "SERVER_DECISION" | "DAEMON_RECEIVE" | "DAEMON_PENDING" | "DAEMON_DRAIN" | "ACK" | "TERMINAL_ERROR";
  }> = [
    { receipt: "mentionRecordedAt", missingReceipt: "MENTION_RECORDED" },
    { receipt: "serverDecidedAt", missingReceipt: "SERVER_DECISION" },
    { receipt: "daemonReceivedAt", missingReceipt: "DAEMON_RECEIVE" },
    { receipt: "daemonPendingAt", missingReceipt: "DAEMON_PENDING" },
    { receipt: "daemonDrainedAt", missingReceipt: "DAEMON_DRAIN" },
    { receipt: "ackedAt", missingReceipt: "ACK" },
  ];

  let executedCases = 0;
  const observations: MentionDeliveryLookupResult[] = [];
  const expected: MentionDeliveryLookupResult[] = [];
  for (const { receipt, missingReceipt } of cases) {
    const row = ackedBusyOccurrence();
    (row as unknown as Record<string, unknown>)[receipt] = null;
    executedCases += 1;
    observations.push(evaluateMentionDeliveryOccurrence(row));
    expected.push({
      status: "INSTRUMENT_FAILED",
      occurrenceId: row.occurrenceId,
      missingReceipt,
      version: row.version,
    });
  }
  assert.equal(executedCases, cases.length, "directed receipt-suppression path must execute for every transition");

  const terminal = ackedBusyOccurrence();
  terminal.state = "terminal_error";
  terminal.ackedAt = null;
  terminal.terminalErrorAt = null;
  terminal.terminalErrorCode = "DELIVERY_REJECTED";
  executedCases += 1;
  observations.push(evaluateMentionDeliveryOccurrence(terminal));
  expected.push({
    status: "INSTRUMENT_FAILED",
    occurrenceId: terminal.occurrenceId,
    missingReceipt: "TERMINAL_ERROR",
    version: terminal.version,
  });
  assert.equal(executedCases, cases.length + 1, "terminal receipt suppression path must execute");
  assert.deepEqual(
    observations,
    expected,
    `all ${executedCases} directed receipt-suppression paths executed before projection comparison`,
  );
});

test("lookup projection reports the first genuinely broken hop before any later transition", () => {
  const row = ackedBusyOccurrence();
  row.state = "recorded";
  row.deliveryPath = "unknown";
  row.serverDecidedAt = null;
  row.daemonReceivedAt = null;
  row.daemonPendingAt = null;
  row.daemonDrainedAt = null;
  row.ackedAt = null;

  assert.deepEqual(evaluateMentionDeliveryOccurrence(row), {
    status: "BROKEN_HOP",
    occurrenceId: row.occurrenceId,
    hop: "SERVER_DECISION",
    version: row.version,
  });
});

test("durable busy occurrence survives recovery listing, drains once, and CAS redrive fails after ACK", async ({ db: database }) => {

  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `mention-delivery-${suffix}@raft.test`,
    name: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Mention ${suffix.slice(0, 8)}`,
    slug: `mention-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `channel-${suffix}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: `hello @${agent.name}`,
    seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id,
    messageSeq: 1,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
  }).returning();
  const payload = {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel" as const,
    sender_id: owner.id,
    sender_name: owner.name,
    sender_type: "human" as const,
    content: message.content,
    timestamp: at.toISOString(),
    message_id: message.id,
    seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000005",
    launchId: "launch-1",
    sessionId: "session-1",
  };

  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    deliveryPayload: payload,
  }]);
  assert.deepEqual(await lookupMentionDeliveryOccurrence(message.id, agent.id), {
    status: "BROKEN_HOP",
    occurrenceId: mention.id,
    hop: "SERVER_DECISION",
    version: 0,
  });

  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id,
    agentId: agent.id,
    messageId: message.id,
    identity,
    stage: "daemon_received",
  });
  const pending = await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id,
    agentId: agent.id,
    messageId: message.id,
    identity,
    stage: "daemon_pending",
  });
  assert.ok(pending);

  // This list is the ready-reconcile source after the daemon-local pending map
  // is gone. Re-reading it must retain the immutable mention occurrence id.
  const recoverable = await listRecoverableMentionDeliveries(identity.machineId);
  assert.equal(recoverable.length, 1);
  assert.equal(recoverable[0]?.occurrenceId, mention.id);
  assert.equal(recoverable[0]?.deliveryPayload?.message_id, message.id);

  const redrive = await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: pending.version,
    identity,
  });
  assert.ok(redrive, "first exact-version redrive must claim the occurrence once");
  assert.equal(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: redrive.version,
    identity,
  }), null, "a second redrive must fail closed even with the new row version");

  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id,
    agentId: agent.id,
    messageId: message.id,
    identity,
    stage: "daemon_drained",
  });
  const acked = await recordMentionDeliveryAck({
    occurrenceId: mention.id,
    agentId: agent.id,
    messageId: message.id,
    identity,
  });
  assert.ok(acked);
  assert.equal((await listRecoverableMentionDeliveries(identity.machineId)).length, 0);
  assert.equal((await lookupMentionDeliveryOccurrence(message.id, agent.id)).status, "ACKED");

  const afterAck = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(afterAck);
  assert.equal(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: afterAck.version,
    identity,
  }), null, "ACKed occurrences must never be redriven");
});

// GUARD-ISOLATION ARMS, added 2026-08-20 after @Hipp mutation-tested the CAS in
// claimMentionDeliveryRedrive and found three of its four guards had no teeth:
//   suppress the ACK guard      (isNull(ackedAt) + ne(state,"acked"))  ⇒ suite stayed GREEN
//   suppress the version guard  (eq(version, expectedVersion))         ⇒ suite stayed GREEN
//   suppress the identity guard (eq(machineIdSnapshot, …))             ⇒ suite stayed GREEN
//   suppress eq(redriveCount, 0)                                       ⇒ killed
//
// The reason is worth more than the fix. The test above is named "... CAS redrive fails after
// ACK", and it does assert a post-ACK redrive returns null — but it reaches that assertion only
// AFTER a successful redrive has already set redriveCount to 1, so `eq(redriveCount, 0)` is what
// actually blocks it. It passes for a different reason than the one in its name, which is worse
// than having no test: a reader scanning the suite sees ACK covered.
//
// Each arm below therefore reaches its condition WITHOUT ever redriving, so redriveCount stays 0
// and cannot mask the guard under test. Acceptance is by mutation: suppressing exactly one guard
// must redden exactly the arm named for it.
async function pendingOccurrenceFixture() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `guard-${suffix}@raft.test`,
    name: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Guard ${suffix.slice(0, 8)}`,
    slug: `guard-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `channel-${suffix}`,
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: `hello @${agent.name}`,
    seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id,
    messageSeq: 1,
    serverId: server.id,
    channelId: channel.id,
    targetType: "agent",
    targetId: agent.id,
    handleAtSendTime: agent.name,
  }).returning();
  const payload = {
    channel_id: channel.id,
    channel_name: channel.name,
    channel_type: "channel" as const,
    sender_id: owner.id,
    sender_name: owner.name,
    sender_type: "human" as const,
    content: message.content,
    timestamp: at.toISOString(),
    message_id: message.id,
    seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000005",
    launchId: "launch-1",
    sessionId: "session-1",
  };
  await ensureMentionDeliveryOccurrences([{
    occurrenceId: mention.id,
    messageId: message.id,
    serverId: server.id,
    agentId: agent.id,
    deliveryPayload: payload,
  }]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
    stage: "daemon_received",
  });
  const pending = await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
    stage: "daemon_pending",
  });
  assert.ok(pending, "fixture must reach daemon_pending");
  return { mention, message, agent, identity, pending };
}

test("ACK guard alone blocks redrive, with redriveCount still 0 so it cannot be masked", async () => {
  const { mention, message, agent, identity } = await pendingOccurrenceFixture();
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
    stage: "daemon_drained",
  });
  const acked = await recordMentionDeliveryAck({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
  });
  assert.ok(acked);

  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(row);
  // The precondition that makes this arm load-bearing: nothing has been redriven, so the
  // redriveCount guard is SATISFIED and only the ACK guard can refuse.
  assert.equal(row.redriveCount, 0, "arm is void if redriveCount is not 0 — it would mask the guard");
  assert.ok(row.ackedAt, "fixture must actually be ACKed");

  assert.equal(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: row.version,
    identity,
  }), null, "an ACKed occurrence must not be redriven even on its first redrive attempt");
});

test("version guard alone blocks redrive on a stale expectedVersion", async () => {
  const { mention, message, agent, identity, pending } = await pendingOccurrenceFixture();
  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(row);
  assert.equal(row.redriveCount, 0, "arm is void if redriveCount is not 0");
  assert.equal(row.ackedAt, null, "arm is void if the row is already ACKed");

  assert.equal(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: pending.version + 1,
    identity,
  }), null, "a redrive quoting a version the row does not hold must fail closed");

  // NEGATIVE CONTROL: the exact version still claims, so the arm above is about the version
  // and not about the call being broken in general.
  assert.ok(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: pending.version,
    identity,
  }), "the exact version must still claim");
});

test("identity guard alone blocks redrive from a different machine, launch, or session", async () => {
  const { mention, message, agent, identity, pending } = await pendingOccurrenceFixture();
  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(row);
  assert.equal(row.redriveCount, 0, "arm is void if redriveCount is not 0");

  for (const [label, wrong] of [
    ["machineId", { ...identity, machineId: "00000000-0000-4000-8000-0000000000ff" }],
    ["launchId", { ...identity, launchId: "launch-OTHER" }],
    ["sessionId", { ...identity, sessionId: "session-OTHER" }],
  ] as const) {
    assert.equal(await claimMentionDeliveryRedrive({
      occurrenceId: mention.id,
      expectedVersion: pending.version,
      identity: wrong,
    }), null, `a redrive from a different ${label} must fail closed`);
  }

  // NEGATIVE CONTROL: the real identity still claims, so the three refusals above are about
  // identity rather than about the occurrence being unclaimable.
  assert.ok(await claimMentionDeliveryRedrive({
    occurrenceId: mention.id,
    expectedVersion: pending.version,
    identity,
  }), "the owning identity must still claim");
});

test("a server decision on an ACKed occurrence returns null, so recovery cannot re-deliver it", async () => {
  // @Hipp found this reviewing #6700; I verified it at both agentOrchestrator call sites before
  // changing anything. The function used to `return existing ?? null`, so a terminal row came back
  // TRUTHY. Both callers then do:
  //     if (!decided) continue;  current = decided;
  //     if (current.state === "daemon_drained") continue;
  //     …enqueue + send
  // An ACKed occurrence passed the first guard and missed the second, and was re-delivered.
  // Reachable by a reconnect race: recovery lists rows → the prior connection's ACK lands → this
  // decision write runs against an already-acked row.
  // It did not reproduce in the wild only because a daemon-side map that never evicts swallowed
  // the duplicate — the invariant was resting on an unbounded memory leak, so the person who
  // eventually fixed that leak would have opened this hole without ever reading this file.
  const { mention, message, agent, identity } = await pendingOccurrenceFixture();
  await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
    stage: "daemon_drained",
  });
  assert.ok(await recordMentionDeliveryAck({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity,
  }), "fixture precondition: the occurrence must actually reach ACKed");

  const payload = (await getMentionDeliveryOccurrence(message.id, agent.id))?.deliveryPayload;
  assert.ok(payload, "fixture precondition: payload must still be present");

  assert.equal(
    await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity }),
    null,
    "an ACKed occurrence must yield null — a truthy row here is re-delivered by both callers",
  );
});

test("a server decision on a TERMINAL_ERROR occurrence also returns null", async () => {
  // The acked half had an arm; this half did not. @Hipp proved it by mutation: deleting
  // `|| existing.state === "terminal_error"` still left the suite 7/7 green. Reachability is the
  // same shape as acked, and the recovery path itself writes terminal_error, so this is not a
  // theoretical branch.
  const { mention, message, agent, identity } = await pendingOccurrenceFixture();
  await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error", terminalErrorAt: new Date(), terminalErrorCode: "DELIVERY_REJECTED",
  }).where(eq(mentionDeliveryOccurrences.occurrenceId, mention.id));
  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(row);
  assert.equal(row.state, "terminal_error", "fixture precondition: must actually be terminal_error");
  assert.equal(
    await recordMentionDeliveryServerDecision({
      occurrenceId: mention.id, payload: row.deliveryPayload!, identity,
    }),
    null,
    "a terminal_error occurrence must yield null, exactly as acked does",
  );
});

test("a terminal receipt with a NULL code is not reported as an ordinary broken hop", async () => {
  // The database accepts this row: the 0240 CHECK is
  //   (state = 'terminal_error') = (terminal_error_at IS NOT NULL AND code IS NOT NULL)
  // so timestamp-set + code-NULL makes the right side FALSE, and any non-terminal state satisfies
  // it. I first misread that constraint as forbidding this and reverted @Hipp's fix; he built the
  // row, I reproduced it. laterReceiptExists must therefore count terminalErrorAt on every hop.
  // CHANGED 2026-08-20: the shape is now REJECTED BY THE DATABASE (0240's terminal_error_shape
  // gained `AND ((terminal_error_at IS NULL) = (terminal_error_code IS NULL))`), so this arm can no
  // longer persist it — the arm below proves that rejection. The SUBJECT here is the evaluator, not
  // the schema, and `evaluateMentionDeliveryOccurrence` is pure, so the row is built IN MEMORY.
  // Keeping it is deliberate defence-in-depth: a CHECK does nothing for rows written before it or
  // by a path that bypasses this schema, and `undefined >= n` remains false either way.
  const { message, agent } = await pendingOccurrenceFixture();
  const persisted = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(persisted);
  const row = { ...persisted, terminalErrorAt: new Date(), terminalErrorCode: null };
  assert.notEqual(row.state, "terminal_error", "fixture precondition: the row is NOT terminal state");
  assert.ok(row.terminalErrorAt, "fixture precondition: but it does carry a terminal receipt");
  const verdict = evaluateMentionDeliveryOccurrence(row);
  assert.notEqual(
    verdict.status, "BROKEN_HOP",
    "a row carrying a terminal receipt must not be reported as an ordinary broken hop",
  );
});

test("the same terminal receipt is not an ordinary broken hop at DAEMON_PENDING either", async () => {
  // @Hipp re-bound to ef45200f and mutated the OTHER hop: deleting terminalErrorAt from
  // DAEMON_PENDING still left the suite 9/9. My previous arm only ever exercised DAEMON_DRAIN,
  // because pendingOccurrenceFixture() advances to daemon_pending and the missing hop is
  // therefore the drain. So I had applied "mutate both sides" to acked/terminal_error and then
  // failed to apply it one function lower, to the two hops I had just edited together.
  // This arm stops at daemon_received so the broken hop is DAEMON_PENDING.
  const { message, agent, identity } = await pendingOccurrenceFixture();
  // Same reason as the arm above: the half-receipt shape no longer persists, so rewind IN MEMORY.
  const persisted = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(persisted);
  const row = {
    ...persisted,
    daemonPendingAt: null,
    daemonDrainedAt: null,
    state: "daemon_received" as const,
    terminalErrorAt: new Date(),
    terminalErrorCode: null,
  };
  assert.equal(row.daemonPendingAt, null, "fixture precondition: the pending hop must be the missing one");
  assert.ok(row.terminalErrorAt, "fixture precondition: but a terminal receipt is present");
  assert.notEqual(row.state, "terminal_error", "fixture precondition: state is NOT terminal");
  const verdict = evaluateMentionDeliveryOccurrence(row);
  assert.notEqual(
    verdict.status, "BROKEN_HOP",
    "a terminal receipt must not read as an ordinary broken hop at DAEMON_PENDING either",
  );
  void identity;
});

/**
 * GUARDS THE INVARIANT THAT A CLOSED REVIEW FINDING RESTS ON. Found by @Hipp while recording why
 * @Kabi's closure is currently safe: of the 8 write paths, 7 use `update().set` with a real
 * incrementing expression, and the 8th — this `ensure` upsert — does not increment. That is fine
 * ONLY because it also does not touch `state`. The precise invariant is therefore:
 *
 *     everything that changes `state` increments `version`;
 *     the one path that does not increment does not change `state`.
 *
 * Nothing enforced the second clause. Add a field to that `set` and @Kabi's closed conclusion
 * silently loses its basis while EVERY EXISTING ARM STAYS GREEN, because the other arms travel the
 * incrementing paths. That is the shape this repo keeps rediscovering: the guard and the thing it
 * guards must not share a route, or the guard cannot see the break.
 *
 * Not a defect today and not introduced by PR #6700 — this is the arm the invariant never had.
 */
test("ensureMentionDeliveryOccurrences is idempotent on state and version", async ({ db: database }) => {

  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `ensure-inv-${suffix}@raft.test`, name: `owner-${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Ensure ${suffix.slice(0, 8)}`, slug: `ensure-${suffix}`, ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: `agent-${suffix}`, runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id, name: `channel-${suffix}`, type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: owner.id, content: `hi @${agent.name}`, seq: 1,
  }).returning();
  const [mention] = await db.insert(messageMentions).values({
    messageId: message.id, messageSeq: 1, serverId: server.id, channelId: channel.id,
    targetType: "agent", targetId: agent.id, handleAtSendTime: agent.name,
  }).returning();

  const payload = {
    channel_id: channel.id, channel_name: channel.name, channel_type: "channel" as const,
    sender_id: owner.id, sender_name: owner.name, sender_type: "human" as const,
    content: message.content, timestamp: at.toISOString(), message_id: message.id, seq: 1,
  };
  const identity = {
    machineId: "00000000-0000-4000-8000-000000000005", launchId: "launch-1", sessionId: "session-1",
  };
  const row = {
    occurrenceId: mention.id, messageId: message.id, serverId: server.id,
    agentId: agent.id, deliveryPayload: payload,
  };

  await ensureMentionDeliveryOccurrences([row]);
  await recordMentionDeliveryServerDecision({ occurrenceId: mention.id, payload, identity });
  const advanced = await recordMentionDeliveryDaemonTransition({
    occurrenceId: mention.id, agentId: agent.id, messageId: message.id, identity, stage: "daemon_received",
  });
  assert.ok(advanced, "fixture must advance past the initial state");

  const before = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.equal(before?.state, "daemon_received", "fixture precondition");

  // The call under test: a re-ensure of an occurrence that has already moved on.
  await ensureMentionDeliveryOccurrences([row]);

  const after = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.equal(after?.state, before?.state, "re-ensuring must not move state — the non-incrementing path must not write it");
  assert.equal(after?.version, before?.version, "re-ensuring must not change version either");
});

/**
 * @HIPP'S THREE FINDINGS ON PR #6700 — the arms his closure conditions ask for.
 * Canonical source: PR #6700 comment 5359756944. Copied from there rather than from his chat
 * restatement, which he flagged as itself a transcription.
 */

test("FINDING 1+3 SCHEMA: a half-written terminal receipt is now REJECTED by the database", async () => {
  // 0240's terminal_error_shape was a biconditional whose right side is an AND over TWO columns.
  // "Right side false" has two causes — neither set, or exactly one set — and a biconditional
  // cannot separate them, so timestamp-set + code-NULL satisfied it for ANY non-terminal state.
  // The pairing conjunct closes that. This arm is the constraint's own witness: without it the
  // schema change is asserted nowhere and could be reverted with every test still green.
  const { mention } = await pendingOccurrenceFixture();
  await assert.rejects(
    () => getDb().update(mentionDeliveryOccurrences).set({
      terminalErrorAt: new Date(),
      terminalErrorCode: null,
    }).where(eq(mentionDeliveryOccurrences.occurrenceId, mention.id)),
    "terminal_error_at without terminal_error_code must violate terminal_error_shape",
  );
});

test("FINDING 2 (R9): an ACKED row carrying a terminal receipt is REJECTED, not stored as clean", async () => {
  // ITS OWN ARM, deliberately not shared with the arm above — @Hipp's condition, and his reason is
  // the load-bearing part: findings 1 and 2 point in OPPOSITE directions (1 mis-reports an anomaly,
  // 2 reports an anomaly AS NORMAL). One arm covering both goes green as soon as either is fixed
  // while the other stays open.
  // Before: state='acked' + acked_at + terminal_error_at with a NULL code was ACCEPTED and
  // evaluate() returned a plain ACKED — a terminal receipt reported as clean, by the very table
  // whose purpose is diagnosis.
  const { mention } = await pendingOccurrenceFixture();
  await assert.rejects(
    () => getDb().update(mentionDeliveryOccurrences).set({
      state: "acked",
      ackedAt: new Date(),
      terminalErrorAt: new Date(),
      terminalErrorCode: null,
    }).where(eq(mentionDeliveryOccurrences.occurrenceId, mention.id)),
    "an acked row carrying a half-written terminal receipt must not be storable",
  );
});

test("POSITIVE CONTROL: the tightened constraint still accepts every LEGAL row", async () => {
  // Without this, a constraint that rejected EVERYTHING would satisfy both arms above. @Hipp
  // measured his proposed fix in both directions rather than only confirming the bad rows fail;
  // this is that second direction, kept in the suite instead of in a one-off measurement.
  const { mention, message, agent } = await pendingOccurrenceFixture();
  const at = new Date();
  await getDb().update(mentionDeliveryOccurrences).set({
    state: "terminal_error", terminalErrorAt: at, terminalErrorCode: "IDENTITY_UNKNOWN",
  }).where(eq(mentionDeliveryOccurrences.occurrenceId, mention.id));
  const row = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.equal(row?.state, "terminal_error", "a fully-formed terminal row must remain storable");
  // and the other legal shape: both terminal columns NULL on a non-terminal row
  await getDb().update(mentionDeliveryOccurrences).set({
    state: "daemon_drained", terminalErrorAt: null, terminalErrorCode: null,
  }).where(eq(mentionDeliveryOccurrences.occurrenceId, mention.id));
  const cleared = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.equal(cleared?.state, "daemon_drained", "clearing both terminal columns must stay legal");
});

test("FINDING 3: an unrecognised state is INSTRUMENT_FAILED, not silently below every rank", async () => {
  // STATE_RANK[unknown] is `undefined` and `undefined >= n` is ALWAYS false, so before this guard an
  // unrecognised state sank below every rank and was diagnosed by timestamps alone — the instrument
  // at its least trustworthy exactly when the thing it instruments has malfunctioned.
  // Pure-function arm: the point is the evaluator's arithmetic, which no schema CHECK can repair
  // for rows that already exist or arrive by another writer path.
  const { message, agent } = await pendingOccurrenceFixture();
  const persisted = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(persisted);
  const verdict = evaluateMentionDeliveryOccurrence({ ...persisted, state: "banana" as never });
  assert.equal(verdict.status, "INSTRUMENT_FAILED", "an unrecognised state must be an instrument failure");
  assert.equal(
    verdict.status === "INSTRUMENT_FAILED" ? verdict.missingReceipt : null,
    "UNRECOGNISED_STATE",
    "and it must say WHY with its own discriminator, not borrow MENTION_RECORDED",
  );
  // POSITIVE CONTROL: a recognised state must NOT take this branch, or the guard would swallow
  // every row and the assertion above would pass for the wrong reason.
  const ok = evaluateMentionDeliveryOccurrence(persisted);
  assert.notEqual(ok.status, "INSTRUMENT_FAILED", "a legal state must not trip the unrecognised-state guard");
});

test("FINDING 1 CODE: the ACK hop counts terminalErrorAt — the arm the fix had no witness for", async () => {
  // WHY THIS EXISTS: I applied @Hipp's one-line fix, ran 15/15 green, then mutated it back — and the
  // suite stayed 15/15. NOTHING covered it. The two arms above look like they do, but
  // pendingOccurrenceFixture() stops at daemon_pending, so their missing hop is DAEMON_DRAIN, whose
  // case has always counted terminalErrorAt. This file already carries a comment about that exact
  // trap from the previous round, and I walked into it anyway one function later.
  // The row is @Hipp's traced path, verbatim: rank 4, no ack, a terminal receipt with no code.
  const { message, agent } = await pendingOccurrenceFixture();
  const persisted = await getMentionDeliveryOccurrence(message.id, agent.id);
  assert.ok(persisted);
  const row = {
    ...persisted,
    state: "daemon_drained" as const,
    daemonDrainedAt: new Date(),
    ackedAt: null,
    terminalErrorAt: new Date(),
    terminalErrorCode: null,
  };
  // FIXTURE PRECONDITIONS — without these the arm could pass by never reaching the ACK hop at all,
  // which is precisely how the previous two arms failed to cover this.
  assert.equal(row.ackedAt, null, "fixture: ACK must be the missing hop");
  assert.ok(row.daemonDrainedAt, "fixture: every earlier hop must be present, or we stop before ACK");
  assert.ok(row.terminalErrorAt, "fixture: a terminal receipt must be present");
  const verdict = evaluateMentionDeliveryOccurrence(row);
  assert.notEqual(verdict.status, "BROKEN_HOP", "a row carrying a terminal receipt is not an ordinary broken hop at ACK");
  assert.equal(verdict.status, "INSTRUMENT_FAILED", "it is an instrument failure");
  assert.equal(
    verdict.status === "INSTRUMENT_FAILED" ? verdict.missingReceipt : null,
    "ACK",
    "and the hop it names must be ACK, so this cannot pass via some other branch",
  );
});
