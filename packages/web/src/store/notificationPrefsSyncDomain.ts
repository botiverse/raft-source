import { createSyncCore } from "@botiverse/raft-shared";
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
import type { ActivityMuteState } from "./channelDomain";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";
import { emitStateViolationTrace } from "../utils/stateViolationTrace";

export const NOTIFICATION_PREFS_SYNC_DOMAIN = "notification_prefs";

export type NotificationPrefsUpdate =
  | {
      type: "channel";
      serverId: string;
      channelId: string;
      state: ActivityMuteState;
    }
  | {
      type: "server";
      serverId: string;
      serverPushMuted: boolean;
      prefsVersion?: number;
    };

export type NotificationPrefsDomainEvent =
  | {
      kind: "notification_prefs:updated";
      update: Extract<NotificationPrefsUpdate, { type: "channel" }>;
    }
  | {
      kind: "notification_prefs:updated";
      update: Extract<NotificationPrefsUpdate, { type: "server" }> & { prefsVersion: number };
    };

export interface NotificationPrefsDomainState {
  prefsByScopeId: Record<string, NotificationPrefsUpdate>;
}

export type NotificationPrefsSyncCoreConsumeResult =
  | { kind: "applied"; outcome: SyncIngestOutcome; update: NotificationPrefsUpdate }
  | { kind: "duplicate_dropped"; outcome: SyncIngestOutcome }
  | { kind: "no_op"; outcome: SyncIngestOutcome }
  | { kind: "fallback"; reason: "missing_prefs_version"; update: NotificationPrefsUpdate };

export function createInitialNotificationPrefsDomainState(): NotificationPrefsDomainState {
  return { prefsByScopeId: {} };
}

export function applyNotificationPrefsDomainEvent(
  state: NotificationPrefsDomainState,
  event: NotificationPrefsDomainEvent,
): NotificationPrefsDomainState {
  const scopeId = scopeIdForNotificationPrefsUpdate(event.update);
  const existing = state.prefsByScopeId[scopeId];
  if (sameNotificationPrefsUpdate(existing, event.update)) return state;
  return {
    ...state,
    prefsByScopeId: {
      ...state.prefsByScopeId,
      [scopeId]: event.update,
    },
  };
}

export function createNotificationPrefsSyncDomain(): SyncDomainConfig<
  NotificationPrefsDomainState,
  NotificationPrefsDomainEvent
> {
  return {
    name: NOTIFICATION_PREFS_SYNC_DOMAIN,
    density: "sparse",
    initialState: createInitialNotificationPrefsDomainState,
    fold: (state, event) => applyNotificationPrefsDomainEvent(state, event),
    fromSnapshot: (snapshot: SyncSnapshot<unknown>) => snapshot.state as NotificationPrefsDomainState,
  };
}

let notificationPrefsSyncCore: SyncCore | null = null;
let notificationPrefsViolationCursor: number | undefined;

function getNotificationPrefsSyncCore(): SyncCore {
  notificationPrefsSyncCore ??= createSyncCore({
    domains: [createNotificationPrefsSyncDomain() as SyncDomainConfig<unknown, unknown>],
  });
  return notificationPrefsSyncCore;
}

export function resetNotificationPrefsSyncCoreForTests(): void {
  notificationPrefsSyncCore = null;
  notificationPrefsViolationCursor = undefined;
}

export function __setNotificationPrefsSyncCoreForTests(core: SyncCore | null): void {
  notificationPrefsSyncCore = core;
  notificationPrefsViolationCursor = undefined;
}

export function scopeIdForNotificationPrefsUpdate(update: NotificationPrefsUpdate): string {
  return update.type === "channel" ? `channel:${update.channelId}` : `server:${update.serverId}`;
}

function prefsVersionForNotificationPrefsUpdate(update: NotificationPrefsUpdate): number | null {
  const prefsVersion = update.type === "channel" ? update.state.prefsVersion : update.prefsVersion;
  return typeof prefsVersion === "number" && Number.isSafeInteger(prefsVersion) && prefsVersion >= 0
    ? prefsVersion
    : null;
}

function notificationPrefsFrame(update: NotificationPrefsUpdate): SyncFrame<NotificationPrefsDomainEvent> | null {
  const prefsVersion = prefsVersionForNotificationPrefsUpdate(update);
  if (prefsVersion === null) return null;
  const event: NotificationPrefsDomainEvent = update.type === "channel"
    ? { kind: "notification_prefs:updated", update }
    : { kind: "notification_prefs:updated", update: { ...update, prefsVersion } };
  return {
    scopeId: scopeIdForNotificationPrefsUpdate(update),
    // Core sequences are exact bigint; widen at the adapter boundary.
    seq: BigInt(prefsVersion),
    epoch: null,
    event,
  };
}

function selectFoldedNotificationPrefsUpdate(
  core: SyncCore,
  update: NotificationPrefsUpdate,
): NotificationPrefsUpdate | null {
  const scopeId = scopeIdForNotificationPrefsUpdate(update);
  const state = core.state<NotificationPrefsDomainState>(NOTIFICATION_PREFS_SYNC_DOMAIN, scopeId);
  return state?.prefsByScopeId[scopeId] ?? null;
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

function syncOutcomeWritesStore(outcome: SyncIngestOutcome): boolean {
  return outcome.kind === "applied" || outcome.kind === "max_advanced";
}

function traceNotificationPrefsSyncTransition(
  outcome: SyncIngestOutcome,
  frame: SyncFrame<NotificationPrefsDomainEvent>,
): void {
  emitStateTransitionTrace({
    domain: NOTIFICATION_PREFS_SYNC_DOMAIN,
    event: frame.event.kind,
    entityId: outcome.scopeId,
    outcome: syncOutcomeToTraceOutcome(outcome),
    outcomeDetail: outcome.kind,
    touched: syncOutcomeTouched(outcome),
    seq: String("seq" in outcome ? outcome.seq : frame.seq),
  });
}

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

function traceNotificationPrefsSyncViolation(record: SyncViolationRecord): void {
  const violationKind = stateViolationKindForSync(record.kind);
  if (violationKind === null) return;
  emitStateViolationTrace({
    domain: NOTIFICATION_PREFS_SYNC_DOMAIN,
    entityId: record.scopeId,
    violationKind,
    epoch: record.epoch ?? undefined,
    same_activity: false,
    same_detail_kind: false,
    same_detail_presence: false,
    same_detail_bucket: false,
    event: "notification_prefs:sync-core",
    outcomeDetail: record.kind,
    serverSeq: record.seq === undefined ? undefined : String(record.seq),
  });
}

function drainNotificationPrefsSyncViolations(core: SyncCore): void {
  const drain = core.violations(notificationPrefsViolationCursor);
  for (const record of drain.records) traceNotificationPrefsSyncViolation(record);
  notificationPrefsViolationCursor = drain.nextIndex;
}

export function consumeNotificationPrefsUpdateWithSyncCore(
  update: NotificationPrefsUpdate,
): NotificationPrefsSyncCoreConsumeResult {
  const frame = notificationPrefsFrame(update);
  if (!frame) return { kind: "fallback", reason: "missing_prefs_version", update };

  const core = getNotificationPrefsSyncCore();
  const outcome = core.ingestFrame(NOTIFICATION_PREFS_SYNC_DOMAIN, frame);
  traceNotificationPrefsSyncTransition(outcome, frame);
  drainNotificationPrefsSyncViolations(core);
  if (outcome.kind === "duplicate_dropped") return { kind: "duplicate_dropped", outcome };
  if (!syncOutcomeWritesStore(outcome)) return { kind: "no_op", outcome };

  return {
    kind: "applied",
    outcome,
    update: selectFoldedNotificationPrefsUpdate(core, update) ?? update,
  };
}

function sameNotificationPrefsUpdate(
  a: NotificationPrefsUpdate | undefined,
  b: NotificationPrefsUpdate,
): boolean {
  if (!a || a.type !== b.type || a.serverId !== b.serverId) return false;
  if (a.type === "server" && b.type === "server") {
    return a.serverPushMuted === b.serverPushMuted && a.prefsVersion === b.prefsVersion;
  }
  if (a.type === "channel" && b.type === "channel") {
    return a.channelId === b.channelId
      && a.state.activityMuted === b.state.activityMuted
      && (a.state.muteFromSeq ?? null) === (b.state.muteFromSeq ?? null)
      && a.state.activityMuteSupported === b.state.activityMuteSupported
      && a.state.prefsVersion === b.state.prefsVersion;
  }
  return false;
}
