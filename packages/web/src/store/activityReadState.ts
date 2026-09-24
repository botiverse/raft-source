import {
  READ_STATE_DOMAIN,
  createReadStateDomain,
  createSyncCore,
  encodeReadStateScopeId,
  toReadStateFrame,
} from "@botiverse/raft-shared";
import type {
  ReadStateFact,
  SyncDomainConfig,
  SyncIngestOutcome,
} from "@botiverse/raft-shared";
import { registerServerReset } from "./serverResetRegistry";

export interface ActivityReadStateIdentity {
  serverId: string | null;
  principalId: string | null;
}

export interface ActivityReadStateIngressContext extends ActivityReadStateIdentity {
  serverEpoch: number;
  generation: number;
}

export type ActivityReadStateAckOutcome = SyncIngestOutcome | { kind: "invalid" };

function newCore() {
  return createSyncCore({
    domains: [createReadStateDomain() as SyncDomainConfig<unknown, unknown>],
  });
}

let activityReadStateCore = newCore();
const activeReadHolds = new Map<string, ReadStateFact>();
const latestLiveSeqByScope = new Map<string, number>();
let activityReadStateRevision = 0;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function holdKey(identity: ActivityReadStateIdentity, scopeId: string): string | null {
  if (!identity.serverId || !identity.principalId || !scopeId) return null;
  return encodeReadStateScopeId({
    serverId: identity.serverId,
    principalId: identity.principalId,
    scopeId,
  });
}

export function getActivityReadStateRevision(): number {
  return activityReadStateRevision;
}

export function acceptActivityReadAllAck(
  context: ActivityReadStateIngressContext,
  scopeId: string,
  payload: { maxReadSeq?: unknown; seq?: unknown; readStateVersion?: unknown } | null | undefined,
): ActivityReadStateAckOutcome {
  const maxReadSeq = payload?.maxReadSeq ?? payload?.seq;
  const readStateVersion = payload?.readStateVersion;
  if (
    !context.serverId
    || !context.principalId
    || !scopeId
    || !isNonNegativeSafeInteger(maxReadSeq)
    || !isNonNegativeSafeInteger(readStateVersion)
  ) {
    return { kind: "invalid" };
  }

  const fact: ReadStateFact = {
    serverId: context.serverId,
    principalId: context.principalId,
    scopeId,
    maxReadSeq,
    readStateVersion,
  };
  const outcome = activityReadStateCore.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(fact));
  if (outcome.kind === "applied" || outcome.kind === "max_advanced") {
    const latestLiveSeq = latestLiveSeqByScope.get(outcome.scopeId);
    if (latestLiveSeq == null || latestLiveSeq <= fact.maxReadSeq) {
      activeReadHolds.set(outcome.scopeId, fact);
    } else {
      activeReadHolds.delete(outcome.scopeId);
    }
    activityReadStateRevision += 1;
  }
  return outcome;
}

export function hasActivityReadHold(identity: ActivityReadStateIdentity, scopeId: string): boolean {
  const key = holdKey(identity, scopeId);
  return key !== null && activeReadHolds.has(key);
}

export function releaseActivityReadHoldForMessage(
  identity: ActivityReadStateIdentity,
  scopeId: string,
  seq: number | null | undefined,
): boolean {
  const key = holdKey(identity, scopeId);
  if (!key || !isNonNegativeSafeInteger(seq)) return false;
  const latestLiveSeq = latestLiveSeqByScope.get(key);
  if (latestLiveSeq == null || seq > latestLiveSeq) latestLiveSeqByScope.set(key, seq);
  const hold = activeReadHolds.get(key);
  if (!hold || seq <= hold.maxReadSeq) return false;
  activeReadHolds.delete(key);
  activityReadStateRevision += 1;
  return true;
}

export function getAcceptedActivityReadState(
  identity: ActivityReadStateIdentity,
  scopeId: string,
): ReadStateFact | null {
  const key = holdKey(identity, scopeId);
  if (!key) return null;
  return activityReadStateCore.state<ReadStateFact | null>(READ_STATE_DOMAIN, key) ?? null;
}

export function resetActivityReadStateForTests(): void {
  activityReadStateCore = newCore();
  activeReadHolds.clear();
  latestLiveSeqByScope.clear();
  activityReadStateRevision = 0;
}

registerServerReset(resetActivityReadStateForTests);
