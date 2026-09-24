import type { SyncDomainConfig, SyncFrame, SyncScopeId, SyncSnapshot } from "../types.js";

export const READ_STATE_DOMAIN = "read_state";

export interface ReadStateFact {
  serverId: string;
  principalId: string;
  scopeId: string;
  maxReadSeq: number;
  readStateVersion: number;
}

export type ReadStateDomainState = ReadStateFact | null;

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isReadStateFact(value: unknown): value is ReadStateFact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fact = value as Record<string, unknown>;
  return typeof fact.serverId === "string"
    && fact.serverId.length > 0
    && typeof fact.principalId === "string"
    && fact.principalId.length > 0
    && typeof fact.scopeId === "string"
    && fact.scopeId.length > 0
    && isNonNegativeSafeInteger(fact.maxReadSeq)
    && isNonNegativeSafeInteger(fact.readStateVersion);
}

/** Collision-safe identity for one receiver-private read-state scope. */
export function encodeReadStateScopeId(
  identity: Pick<ReadStateFact, "serverId" | "principalId" | "scopeId">,
): SyncScopeId {
  return JSON.stringify([identity.serverId, identity.principalId, identity.scopeId]);
}

export function fingerprintReadStateFact(fact: ReadStateFact): string {
  return JSON.stringify([
    fact.serverId,
    fact.principalId,
    fact.scopeId,
    fact.maxReadSeq,
    fact.readStateVersion,
  ]);
}

export function toReadStateFrame(fact: ReadStateFact): SyncFrame<ReadStateFact> {
  return {
    scopeId: encodeReadStateScopeId(fact),
    // read_state is a sparse register keyed by version; the core sequences in
    // exact bigint, so widen here rather than at the core boundary.
    seq: BigInt(fact.readStateVersion),
    epoch: null,
    event: fact,
  };
}

export function createReadStateDomain(): SyncDomainConfig<ReadStateDomainState, ReadStateFact> {
  return {
    name: READ_STATE_DOMAIN,
    density: "sparse",
    initialState: () => null,
    eventFingerprint: fingerprintReadStateFact,
    fold: (_state, event) => event,
    fromSnapshot: (snapshot: SyncSnapshot<unknown>) => isReadStateFact(snapshot.state)
      ? snapshot.state
      : null,
  };
}
