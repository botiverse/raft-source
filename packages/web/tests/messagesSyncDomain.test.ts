import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createSyncCore, createSyncViolationBuffer } from "@botiverse/raft-shared";
import type {
  SyncCore,
  SyncDifferenceResponse,
  SyncDomainConfig,
  SyncFrame,
  SyncIngestOutcome,
  SyncSnapshot,
  SyncViolationRecord,
} from "@botiverse/raft-shared";
import {
  __setMessagesSyncCoreForTests,
  applyMessageDomainEvent,
  consumeSocketMessageNewWithSyncCore,
  createInitialMessageDomainState,
  createMessagesSyncDomain,
  MESSAGES_SYNC_DOMAIN,
  resetMessagesSyncCoreForTests,
} from "../src/store/messageSyncDomain.js";
import type {
  MessageDomainEvent,
} from "../src/store/messageSyncDomain.js";
import type { Message, MessageReaction } from "../src/store/messageStore.js";
import { __setStateTransitionEmitterForTest } from "../src/utils/stateTransitionTrace.js";
import {
  __resetStateViolationCoalescerForTest,
  __setStateViolationEmitterForTest,
} from "../src/utils/stateViolationTrace.js";

const channelId = "channel-messages-domain";
const messageId = "message-1";

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: messageId,
    seq: 1,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: "original body",
    createdAt: "2026-07-10T06:00:00.000Z",
    reactions: [],
    actionMetadata: null,
    ...overrides,
  };
}

function reaction(count = 1): MessageReaction {
  return {
    emoji: "👍",
    count,
    reactorIds: ["user-2"],
    reactorNames: ["Ben"],
  };
}

function frame(seq: number, event: MessageDomainEvent): SyncFrame<MessageDomainEvent> {
  return { scopeId: channelId, seq, epoch: null, event };
}

function messagesDomain(): SyncDomainConfig<unknown, unknown> {
  return createMessagesSyncDomain() as SyncDomainConfig<unknown, unknown>;
}

function captureStateTransitions() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __setStateTransitionEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

function captureStateViolations() {
  const records: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  __resetStateViolationCoalescerForTest();
  __setStateViolationEmitterForTest(((name, attrs) => {
    records.push({ name, attrs: { ...attrs } });
  }) as never);
  return records;
}

function fakeCoreForConsumer({
  outcomes = [],
  violations = [],
}: {
  outcomes?: SyncIngestOutcome[];
  violations?: Array<Omit<SyncViolationRecord, "index">>;
}): SyncCore {
  const buffer = createSyncViolationBuffer({ capacity: 8 });
  for (const record of violations) buffer.push(record);
  let lastMessage = message();
  let outcomeIndex = 0;
  return {
    ingestFrame(_domain, input) {
      if ((input.event as MessageDomainEvent).kind === "message:new") {
        lastMessage = (input.event as Extract<MessageDomainEvent, { kind: "message:new" }>).message;
      }
      return outcomes[outcomeIndex++] ?? { kind: "applied", scopeId: input.scopeId, seq: input.seq };
    },
    ingestSnapshot(_domain: string, _snapshot: SyncSnapshot) {
      throw new Error("not used in messages sync consumer tests");
    },
    ingestDifference(_domain: string, _response: SyncDifferenceResponse) {
      throw new Error("not used in messages sync consumer tests");
    },
    pendingRequests() {
      return [];
    },
    state() {
      return { channelMessages: { [channelId]: [lastMessage] } };
    },
    scopeSyncState() {
      return { appliedSeq: lastMessage.seq ?? 0, epoch: null, repairPending: false };
    },
    violations(sinceIndex?: number) {
      return buffer.drain(sinceIndex);
    },
  };
}

function fakeCoreWithViolations(records: Array<Omit<SyncViolationRecord, "index">>): SyncCore {
  return fakeCoreForConsumer({ violations: records });
}

function violationKey(violationKind: string, epoch: string) {
  return {
    domain: "messages",
    entityId: channelId,
    violationKind,
    epoch,
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: false,
    same_detail_bucket: false,
  };
}

function violationMeta(outcomeDetail: string, serverSeq: string) {
  return {
    count: 1,
    event: "message:sync-core",
    outcomeDetail,
    serverSeq,
  };
}

afterEach(() => {
  __setStateTransitionEmitterForTest(null);
  __setStateViolationEmitterForTest(null);
  __resetStateViolationCoalescerForTest();
  resetMessagesSyncCoreForTests();
});

test("messages sync domain: core-mediated fold equals the direct channel-bucket fold", () => {
  const events = [
    frame(1, { kind: "message:new", message: message({ seq: 1 }) }),
    frame(2, { kind: "message:updated", message: { id: messageId, channelId, content: "edited body" } }),
    frame(3, { kind: "message:updated", message: { id: messageId, channelId, reactions: [reaction(3)] } }),
  ];

  const core = createSyncCore({ domains: [messagesDomain()] });
  let direct = createInitialMessageDomainState();
  for (const item of events) {
    core.ingestFrame(MESSAGES_SYNC_DOMAIN, item);
    direct = applyMessageDomainEvent(direct, item.event);
  }

  assert.deepEqual(core.state(MESSAGES_SYNC_DOMAIN, channelId), direct);
  assert.deepEqual(direct.channelMessages[channelId]?.map((row) => row.id), [messageId]);
  assert.equal(direct.channelMessages[channelId]?.[0]?.content, "edited body");
  assert.deepEqual(direct.channelMessages[channelId]?.[0]?.reactions, [reaction(3)]);
  assert.equal(core.scopeSyncState(MESSAGES_SYNC_DOMAIN, channelId)?.appliedSeq, 3);
  assert.equal(core.pendingRequests().length, 0);
});

test("messages sync domain: update-before-new creates no phantom row and converges after canonical new", () => {
  const core = createSyncCore({ domains: [messagesDomain()] });

  core.ingestFrame(MESSAGES_SYNC_DOMAIN, frame(1, {
    kind: "message:updated",
    message: { id: messageId, channelId, content: "edited before create" },
  }));

  assert.deepEqual(core.state(MESSAGES_SYNC_DOMAIN, channelId), { channelMessages: {} });

  core.ingestFrame(MESSAGES_SYNC_DOMAIN, frame(2, {
    kind: "message:new",
    message: message({ seq: 2, content: "edited before create" }),
  }));

  const state = core.state<ReturnType<typeof createInitialMessageDomainState>>(MESSAGES_SYNC_DOMAIN, channelId);
  assert.equal(state?.channelMessages[channelId]?.length, 1);
  assert.equal(state?.channelMessages[channelId]?.[0]?.content, "edited before create");
});

test("messages sync domain: duplicate frames are dropped before re-entering the fold", () => {
  const core = createSyncCore({ domains: [messagesDomain()] });

  core.ingestFrame(MESSAGES_SYNC_DOMAIN, frame(1, {
    kind: "message:new",
    message: message({ seq: 1, content: "original body" }),
  }));
  const before = core.state(MESSAGES_SYNC_DOMAIN, channelId);
  const outcome = core.ingestFrame(MESSAGES_SYNC_DOMAIN, frame(1, {
    kind: "message:new",
    message: message({ seq: 1, content: "original body" }),
  }));

  assert.equal(outcome.kind, "duplicate_dropped");
  assert.equal(core.state(MESSAGES_SYNC_DOMAIN, channelId), before);
});

test("messages sync consumer: socket message:new returns the folded row for store consumption", () => {
  resetMessagesSyncCoreForTests();

  const first = consumeSocketMessageNewWithSyncCore(message({ seq: 1, content: "original" }));
  assert.equal(first.kind, "applied");
  assert.equal(first.kind === "applied" ? first.message.content : null, "original");

  const merged = consumeSocketMessageNewWithSyncCore(message({ seq: 2, content: "edited by later new echo" }));
  assert.equal(merged.kind, "applied");
  assert.equal(merged.kind === "applied" ? merged.message.content : null, "edited by later new echo");
});

test("messages sync consumer: duplicate socket message:new does not re-enter the store path", () => {
  resetMessagesSyncCoreForTests();

  assert.equal(consumeSocketMessageNewWithSyncCore(message({ seq: 7 })).kind, "applied");
  const duplicate = consumeSocketMessageNewWithSyncCore(message({ seq: 7, content: "duplicate" }));

  assert.equal(duplicate.kind, "duplicate_dropped");
});

test("messages sync consumer: flag-on applied and duplicate outcomes emit message-domain transitions", () => {
  resetMessagesSyncCoreForTests();
  const records = captureStateTransitions();

  assert.equal(consumeSocketMessageNewWithSyncCore(message({ seq: 7 })).kind, "applied");
  assert.equal(consumeSocketMessageNewWithSyncCore(message({ seq: 7, content: "duplicate" })).kind, "duplicate_dropped");

  assert.deepEqual(records.map((record) => record.name), [
    "slock.state.transition",
    "slock.state.transition",
  ]);
  assert.deepEqual(records.map((record) => record.attrs), [
    {
      key: {
        domain: "messages",
        event: "message:new",
        outcome: "applied",
        entityId: channelId,
      },
      meta: {
        outcomeDetail: "max_advanced",
        touched: 1,
        seq: "7",
        timestamp: "2026-07-10T06:00:00.000Z",
      },
    },
    {
      key: {
        domain: "messages",
        event: "message:new",
        outcome: "noop",
        entityId: channelId,
      },
      meta: {
        outcomeDetail: "duplicate_dropped",
        touched: 0,
        seq: "7",
        timestamp: "2026-07-10T06:00:00.000Z",
      },
    },
  ]);
});

test("messages sync consumer: transition trace maps every sync-core outcome explicitly", () => {
  const records = captureStateTransitions();
  __setMessagesSyncCoreForTests(fakeCoreForConsumer({
    outcomes: [
      { kind: "applied", scopeId: channelId, seq: 101n },
      { kind: "max_advanced", scopeId: channelId, seq: 42n },
      { kind: "duplicate_dropped", scopeId: channelId, seq: 103n },
      { kind: "gap_repair_requested", scopeId: channelId, fromSeq: 104n, toSeq: 106n },
      { kind: "epoch_rebaseline_requested", scopeId: channelId },
      { kind: "violation", scopeId: channelId, violation: "cross_epoch_arrival" },
    ],
  }));

  for (let seq = 1; seq <= 6; seq += 1) {
    consumeSocketMessageNewWithSyncCore(message({ seq }));
  }

  assert.deepEqual(records.map((record) => record.attrs), [
    {
      key: { domain: "messages", event: "message:new", outcome: "applied", entityId: channelId },
      meta: { outcomeDetail: "applied", touched: 1, seq: "101", timestamp: "2026-07-10T06:00:00.000Z" },
    },
    {
      key: { domain: "messages", event: "message:new", outcome: "applied", entityId: channelId },
      meta: { outcomeDetail: "max_advanced", touched: 1, seq: "42", timestamp: "2026-07-10T06:00:00.000Z" },
    },
    {
      key: { domain: "messages", event: "message:new", outcome: "noop", entityId: channelId },
      meta: { outcomeDetail: "duplicate_dropped", touched: 0, seq: "103", timestamp: "2026-07-10T06:00:00.000Z" },
    },
    {
      key: { domain: "messages", event: "message:new", outcome: "conflict", entityId: channelId },
      meta: { outcomeDetail: "gap_repair_requested", touched: 0, seq: "4", timestamp: "2026-07-10T06:00:00.000Z" },
    },
    {
      key: { domain: "messages", event: "message:new", outcome: "conflict", entityId: channelId },
      meta: { outcomeDetail: "epoch_rebaseline_requested", touched: 0, seq: "5", timestamp: "2026-07-10T06:00:00.000Z" },
    },
    {
      key: { domain: "messages", event: "message:new", outcome: "conflict", entityId: channelId },
      meta: { outcomeDetail: "violation", touched: 0, seq: "6", timestamp: "2026-07-10T06:00:00.000Z" },
    },
  ]);
});

test("messages sync consumer: transition trace skips unmapped sync-core outcomes", () => {
  const records = captureStateTransitions();
  __setMessagesSyncCoreForTests(fakeCoreForConsumer({
    outcomes: [
      { kind: "unmapped_outcome", scopeId: channelId, seq: 1 } as unknown as SyncIngestOutcome,
    ],
  }));

  consumeSocketMessageNewWithSyncCore(message({ seq: 1 }));

  assert.deepEqual(records, []);
});

test("messages sync consumer: violation drain uses the core cursor and emits records exactly once", () => {
  const violations = captureStateViolations();
  __setMessagesSyncCoreForTests(fakeCoreWithViolations([
    {
      kind: "producer_seq_conflict",
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 1,
      epoch: "epoch-a",
    },
    {
      kind: "cross_epoch_arrival",
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 2,
      epoch: "epoch-b",
    },
    {
      kind: "stale_flood",
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 3,
      epoch: "epoch-c",
    },
    {
      kind: "version_regression",
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 4,
      epoch: "epoch-d",
    },
    {
      kind: "producer_version_conflict",
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 5,
      epoch: "epoch-e",
    },
    {
      kind: "unmapped_sync_kind" as SyncViolationRecord["kind"],
      domain: MESSAGES_SYNC_DOMAIN,
      scopeId: channelId,
      seq: 6,
      epoch: "epoch-f",
    },
  ]));

  assert.equal(consumeSocketMessageNewWithSyncCore(message({ seq: 8 })).kind, "applied");
  assert.equal(consumeSocketMessageNewWithSyncCore(message({ seq: 9 })).kind, "applied");

  assert.equal(violations.length, 5);
  assert.deepEqual(violations.map((record) => record.name), Array(5).fill("slock.state.violation"));
  assert.deepEqual(violations.map((record) => record.attrs.key), [
    violationKey("producer_seq_conflict", "epoch-a"),
    violationKey("cross_epoch_arrival", "epoch-b"),
    violationKey("stale_flood", "epoch-c"),
    violationKey("version_regression", "epoch-d"),
    violationKey("producer_version_conflict", "epoch-e"),
  ]);
  assert.deepEqual(violations.map((record) => record.attrs.meta), [
    violationMeta("producer_seq_conflict", "1"),
    violationMeta("cross_epoch_arrival", "2"),
    violationMeta("stale_flood", "3"),
    violationMeta("version_regression", "4"),
    violationMeta("producer_version_conflict", "5"),
  ]);
});

test("messages sync consumer: missing message seq falls back to the legacy store path", () => {
  resetMessagesSyncCoreForTests();

  const noSeq = { ...message(), seq: undefined } as Message;
  const result = consumeSocketMessageNewWithSyncCore(noSeq);

  assert.deepEqual(result, { kind: "fallback", reason: "missing_seq", message: noSeq });
});
