import { createSyncCore } from "@botiverse/raft-shared";
import { CANONICAL_MESSAGE_FIELD_DESCRIPTORS } from "../../../shared/src/canonicalMessageManifest.js";
import type {
  StateTransitionOutcome,
  StateViolationKind,
  SyncCore,
  SyncDomainConfig,
  SyncFrame,
  SyncIngestOutcome,
  SyncSnapshot,
  SyncViolationKind,
  SyncViolationRecord,
} from "@botiverse/raft-shared";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { emitStateViolationTrace } from "../utils/stateViolationTrace";
import { registerMessagesSyncCoreReset } from "./messageSyncCoreReset";
export { SYNC_CORE_MESSAGES_FLAG_KEY } from "./serverFeatureFlags";
import {
  sortBySeq,
} from "./messageStore";
import type {
  Message,
} from "./messageStore";

export const MESSAGES_SYNC_DOMAIN = "messages";

export type MessageDomainEvent =
  | { kind: "message:new"; message: Message }
  | { kind: "message:updated"; message: Pick<Message, "id" | "channelId"> & Partial<Message> };

export interface MessageDomainState {
  channelMessages: Record<string, Message[]>;
}

export function createInitialMessageDomainState(): MessageDomainState {
  return { channelMessages: {} };
}

const COMMENT_REF_MERGE_POLICY = CANONICAL_MESSAGE_FIELD_DESCRIPTORS.find(
  (field) => field.name === "commentRef",
)?.mergePolicy;

function mergeCanonicalMessageProjection(
  existing: Message,
  incoming: Pick<Message, "id" | "channelId"> & Partial<Message>,
): Message {
  let changed = false;
  for (const [key, value] of Object.entries(incoming) as Array<[keyof Message, unknown]>) {
    if (
      key === "commentRef"
      && COMMENT_REF_MERGE_POLICY === "shared-null-preserve"
      && existing.commentRef
      && value == null
    ) {
      continue;
    }
    if (existing[key] !== value) {
      changed = true;
      break;
    }
  }
  if (!changed) return existing;

  const merged: Message = { ...existing, ...incoming };
  if (
    COMMENT_REF_MERGE_POLICY === "shared-null-preserve"
    && existing.commentRef
    && incoming.commentRef == null
  ) {
    merged.commentRef = existing.commentRef;
  }
  return merged;
}

function withBucket(
  state: MessageDomainState,
  channelId: string,
  bucket: Message[],
): MessageDomainState {
  return {
    ...state,
    channelMessages: {
      ...state.channelMessages,
      [channelId]: bucket,
    },
  };
}

function applyMessageNew(state: MessageDomainState, message: Message): MessageDomainState {
  const bucket = state.channelMessages[message.channelId] ?? [];
  const existingIndex = bucket.findIndex((row) => row.id === message.id);
  if (existingIndex >= 0) {
    const merged = mergeCanonicalMessageProjection(bucket[existingIndex]!, message);
    if (merged === bucket[existingIndex]) return state;
    return withBucket(
      state,
      message.channelId,
      bucket.map((row, index) => index === existingIndex ? merged : row),
    );
  }
  return withBucket(state, message.channelId, sortBySeq([...bucket, message]));
}

function applyMessageUpdated(
  state: MessageDomainState,
  message: Pick<Message, "id" | "channelId"> & Partial<Message>,
): MessageDomainState {
  const bucket = state.channelMessages[message.channelId];
  if (!bucket) return state;

  let touched = false;
  let changed = false;
  const mergedBucket = bucket.map((row) => {
    if (row.id !== message.id) return row;
    touched = true;
    const merged = mergeCanonicalMessageProjection(row, message);
    if (merged !== row) changed = true;
    return merged;
  });

  if (!touched || !changed) return state;
  return withBucket(state, message.channelId, mergedBucket);
}

export function applyMessageDomainEvent(
  state: MessageDomainState,
  event: MessageDomainEvent,
): MessageDomainState {
  switch (event.kind) {
    case "message:new":
      return applyMessageNew(state, event.message);
    case "message:updated":
      return applyMessageUpdated(state, event.message);
  }
}

export function createMessagesSyncDomain(): SyncDomainConfig<MessageDomainState, MessageDomainEvent> {
  return {
    name: MESSAGES_SYNC_DOMAIN,
    // Compat slice: production message delivery still owns gap repair today.
    // The sync-core installation starts as sparse so current socket facts can
    // enter the pure fold without changing baseline assertions.
    density: "sparse",
    initialState: createInitialMessageDomainState,
    fold: (state, event) => applyMessageDomainEvent(state, event),
    fromSnapshot: (snapshot: SyncSnapshot<unknown>) => snapshot.state as MessageDomainState,
  };
}

export type MessageSyncCoreConsumeResult =
  | { kind: "applied"; outcome: SyncIngestOutcome; message: Message }
  | { kind: "duplicate_dropped"; outcome: SyncIngestOutcome }
  | { kind: "fallback"; reason: "missing_seq"; message: Message };

let messagesSyncCore: SyncCore | null = null;
let messagesSyncViolationCursor: number | undefined;
type MessageNewFrame = SyncFrame<Extract<MessageDomainEvent, { kind: "message:new" }>>;

function getMessagesSyncCore(): SyncCore {
  messagesSyncCore ??= createSyncCore({
    domains: [createMessagesSyncDomain() as SyncDomainConfig<unknown, unknown>],
  });
  return messagesSyncCore;
}

export function resetMessagesSyncCore() {
  messagesSyncCore = null;
  messagesSyncViolationCursor = undefined;
}

export const resetMessagesSyncCoreForTests = resetMessagesSyncCore;

registerMessagesSyncCoreReset(resetMessagesSyncCore);

export function __setMessagesSyncCoreForTests(core: SyncCore | null): void {
  messagesSyncCore = core;
  messagesSyncViolationCursor = undefined;
}

function messageNewFrame(message: Message): MessageNewFrame | null {
  if (
    typeof message.seq !== "number" ||
    !Number.isSafeInteger(message.seq) ||
    message.seq <= 0
  ) {
    return null;
  }
  return {
    scopeId: message.channelId,
    // Core sequences are exact bigint; widen at the adapter boundary.
    seq: BigInt(message.seq),
    epoch: null,
    event: { kind: "message:new", message },
  };
}

function selectFoldedMessage(core: SyncCore, message: Message): Message | null {
  const state = core.state<MessageDomainState>(MESSAGES_SYNC_DOMAIN, message.channelId);
  return state?.channelMessages[message.channelId]?.find((row) => row.id === message.id) ?? null;
}

function syncOutcomeToTraceOutcome(outcome: SyncIngestOutcome): StateTransitionOutcome {
  switch (outcome.kind) {
    case "applied":
    case "max_advanced":
      return "applied";
    case "duplicate_dropped":
      return "noop";
    case "epoch_rebaseline_requested":
    case "gap_repair_requested":
    case "violation":
      return "conflict";
  }
}

function syncOutcomeTouched(outcome: SyncIngestOutcome): number {
  return outcome.kind === "applied" || outcome.kind === "max_advanced" ? 1 : 0;
}

function traceMessageSyncTransition(outcome: SyncIngestOutcome, frame: MessageNewFrame): void {
  const traceOutcome = syncOutcomeToTraceOutcome(outcome);
  if (!traceOutcome) return;
  emitStateTransitionTrace({
    domain: MESSAGES_SYNC_DOMAIN,
    event: frame.event.kind,
    entityId: outcome.scopeId,
    outcome: traceOutcome,
    outcomeDetail: outcome.kind,
    touched: syncOutcomeTouched(outcome),
    epoch: frame.epoch ?? undefined,
    seq: String("seq" in outcome ? outcome.seq : frame.seq),
    timestamp: frame.event.message.createdAt,
  });
}

// TODO(RFC047-S1-registry): replace this interim local projection with the
// S1 machine-readable trace registry once that typed module lands.
const SYNC_TO_STATE_VIOLATION_KIND = {
  producer_seq_conflict: "producer_seq_conflict",
  cross_epoch_arrival: "cross_epoch_arrival",
  stale_flood: "stale_flood",
  version_regression: "version_regression",
  producer_version_conflict: "producer_version_conflict",
} satisfies Record<SyncViolationKind, StateViolationKind>;

function stateViolationKindForSync(kind: string): StateViolationKind | null {
  if (!Object.prototype.hasOwnProperty.call(SYNC_TO_STATE_VIOLATION_KIND, kind)) return null;
  return SYNC_TO_STATE_VIOLATION_KIND[kind as SyncViolationKind];
}

function traceMessageSyncViolation(record: SyncViolationRecord): void {
  const violationKind = stateViolationKindForSync(record.kind);
  if (violationKind === null) return;
  emitStateViolationTrace({
    domain: MESSAGES_SYNC_DOMAIN,
    entityId: record.scopeId,
    violationKind,
    epoch: record.epoch ?? undefined,
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: false,
    same_detail_bucket: false,
    event: "message:sync-core",
    outcomeDetail: record.kind,
    serverSeq: record.seq === undefined ? undefined : String(record.seq),
  });
}

function drainMessageSyncViolations(core: SyncCore): void {
  const drain = core.violations(messagesSyncViolationCursor);
  for (const record of drain.records) traceMessageSyncViolation(record);
  messagesSyncViolationCursor = drain.nextIndex;
}

export function consumeSocketMessageNewWithSyncCore(message: Message): MessageSyncCoreConsumeResult {
  const frame = messageNewFrame(message);
  if (!frame) return { kind: "fallback", reason: "missing_seq", message };

  const core = getMessagesSyncCore();
  const outcome = core.ingestFrame(MESSAGES_SYNC_DOMAIN, frame);
  traceMessageSyncTransition(outcome, frame);
  drainMessageSyncViolations(core);
  if (outcome.kind === "duplicate_dropped") return { kind: "duplicate_dropped", outcome };

  return {
    kind: "applied",
    outcome,
    message: selectFoldedMessage(core, message) ?? message,
  };
}
