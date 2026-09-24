import { traceFamilyRegistration } from "./traceFamilyRegistry";

export const STATE_TRANSITION_DOMAINS = [
  "inbox",
  "machine",
  "agents",
  "server",
  "channel",
  "task",
  "messages",
  "notification_prefs",
] as const;

export type StateTransitionDomain = (typeof STATE_TRANSITION_DOMAINS)[number];
export type StateTransitionOutcome = "applied" | "noop" | "conflict";

export const STATE_TRANSITION_KEY_FIELDS = [
  "domain",
  "event",
  "outcome",
  "entityId",
] as const;

export const STATE_TRANSITION_META_FIELDS = [
  "outcomeDetail",
  "touched",
  "recoveryAction",
  "reconcileSuggested",
  "epoch",
  "seq",
  "timestamp",
] as const;

export const STATE_TRANSITION_JOIN_FIELDS = ["clientEventId"] as const;

export interface StateTransitionTraceKey {
  readonly domain: StateTransitionDomain;
  readonly event: string;
  readonly outcome: StateTransitionOutcome;
  readonly entityId: string;
}

export interface StateTransitionTraceMeta {
  readonly outcomeDetail: string;
  readonly touched: number;
  readonly recoveryAction?: string | null;
  readonly reconcileSuggested?: boolean;
  readonly epoch?: string | number;
  readonly seq?: string | number;
  readonly timestamp?: string | number;
}

export interface StateTransitionTraceJoin {
  readonly clientEventId?: string;
}

export interface StateTransitionTraceAttrs {
  readonly key: StateTransitionTraceKey;
  readonly meta: StateTransitionTraceMeta;
  readonly join?: StateTransitionTraceJoin;
}

export interface StateTransitionTraceInput {
  readonly domain: StateTransitionDomain;
  readonly event: string;
  readonly entityId?: string | null;
  readonly outcome?: StateTransitionOutcome;
  readonly outcomeDetail?: string;
  readonly touched?: number;
  readonly recoveryAction?: string | null;
  readonly reconcileSuggested?: boolean;
  readonly epoch?: string | number;
  readonly seq?: string | number;
  readonly timestamp?: string | number;
  readonly join?: StateTransitionTraceJoin;
}

export function buildStateTransitionTraceAttrs(input: StateTransitionTraceInput): StateTransitionTraceAttrs {
  const registration = traceFamilyRegistration("slock.state.transition");
  if (registration.privacyTier !== "bisect") {
    throw new Error("slock.state.transition must remain registered as bisect tier to carry entityId");
  }

  const touched = Math.max(0, input.touched ?? 0);
  const outcome = input.outcome ?? (touched > 0 ? "applied" : "noop");
  return dropUndefined({
    key: {
      domain: input.domain,
      event: input.event,
      outcome,
      entityId: input.entityId ?? "none",
    },
    meta: dropUndefined({
      outcomeDetail: input.outcomeDetail ?? outcome,
      touched,
      recoveryAction: input.recoveryAction,
      reconcileSuggested: input.reconcileSuggested,
      epoch: input.epoch,
      seq: input.seq,
      timestamp: input.timestamp,
    }),
    join: buildJoin(input.join),
  });
}

function buildJoin(input: StateTransitionTraceJoin | undefined): StateTransitionTraceJoin | undefined {
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
