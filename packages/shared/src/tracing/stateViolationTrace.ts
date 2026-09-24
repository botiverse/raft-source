import { traceFamilyRegistration } from "./traceFamilyRegistry";
import type { StateTransitionDomain } from "./stateTransitionTrace";

export const STATE_VIOLATION_KINDS = [
  "producer_seq_conflict",
  "cross_epoch_arrival",
  "stale_flood",
  "version_regression",
  "producer_version_conflict",
] as const;

export type StateViolationKind = (typeof STATE_VIOLATION_KINDS)[number];

export const STATE_VIOLATION_KEY_FIELDS = [
  "domain",
  "entityId",
  "violationKind",
  "epoch",
  "same_activity",
  "same_detail_kind",
  "same_detail_presence",
  "same_detail_bucket",
] as const;

export const STATE_VIOLATION_META_FIELDS = [
  "count",
  "event",
  "outcomeDetail",
  "serverSeq",
  "timestamp",
  "currentActivity",
  "projectedActivity",
  "currentDetailKind",
  "projectedDetailKind",
] as const;

export const STATE_VIOLATION_JOIN_FIELDS = ["clientEventId"] as const;

export interface StateViolationTraceKey {
  readonly domain: StateTransitionDomain;
  readonly entityId: string;
  readonly violationKind: StateViolationKind;
  readonly epoch: string | number;
  readonly same_activity: boolean;
  readonly same_detail_kind: boolean;
  readonly same_detail_presence: boolean;
  readonly same_detail_bucket: boolean;
}

export interface StateViolationTraceMeta {
  readonly count: number;
  readonly event?: string;
  readonly outcomeDetail?: string;
  readonly serverSeq?: string | number;
  readonly timestamp?: string | number;
  readonly currentActivity?: string;
  readonly projectedActivity?: string;
  readonly currentDetailKind?: string;
  readonly projectedDetailKind?: string;
}

export interface StateViolationTraceJoin {
  readonly clientEventId?: string;
}

export interface StateViolationTraceAttrs {
  readonly key: StateViolationTraceKey;
  readonly meta: StateViolationTraceMeta;
  readonly join?: StateViolationTraceJoin;
}

export interface StateViolationTraceInput {
  readonly domain: StateTransitionDomain;
  readonly entityId?: string | null;
  readonly violationKind: StateViolationKind;
  readonly epoch?: string | number | null;
  readonly same_activity: boolean;
  readonly same_detail_kind: boolean;
  readonly same_detail_presence: boolean;
  readonly same_detail_bucket: boolean;
  readonly count?: number;
  readonly event?: string;
  readonly outcomeDetail?: string;
  readonly serverSeq?: string | number;
  readonly timestamp?: string | number;
  readonly currentActivity?: string;
  readonly projectedActivity?: string;
  readonly currentDetailKind?: string;
  readonly projectedDetailKind?: string;
  readonly join?: StateViolationTraceJoin;
}

export function buildStateViolationTraceAttrs(input: StateViolationTraceInput): StateViolationTraceAttrs {
  const registration = traceFamilyRegistration("slock.state.violation");
  if (registration.privacyTier !== "bisect") {
    throw new Error("slock.state.violation must remain registered as bisect tier to carry entityId");
  }

  const count = Math.max(1, Math.floor(input.count ?? 1));
  return dropUndefined({
    key: {
      domain: input.domain,
      entityId: input.entityId ?? "none",
      violationKind: input.violationKind,
      epoch: input.epoch ?? "unknown",
      same_activity: input.same_activity,
      same_detail_kind: input.same_detail_kind,
      same_detail_presence: input.same_detail_presence,
      same_detail_bucket: input.same_detail_bucket,
    },
    meta: dropUndefined({
      count,
      event: input.event,
      outcomeDetail: input.outcomeDetail,
      serverSeq: input.serverSeq,
      timestamp: input.timestamp,
      currentActivity: input.currentActivity,
      projectedActivity: input.projectedActivity,
      currentDetailKind: input.currentDetailKind,
      projectedDetailKind: input.projectedDetailKind,
    }),
    join: buildJoin(input.join),
  });
}

function buildJoin(input: StateViolationTraceJoin | undefined): StateViolationTraceJoin | undefined {
  if (input?.clientEventId === undefined) return undefined;
  return { clientEventId: input.clientEventId };
}

function dropUndefined<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
