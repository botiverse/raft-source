export type ReadReceiptPeerKind = "human" | "agent";

export type PeerReadState = {
  peerKind: ReadReceiptPeerKind;
  peerId: string;
  maxReadSeq: number;
  /** In a thread: this agent stopped following it. Absent: not known to have (agentsStoppedFollowing). */
  stoppedFollowing?: true;
  /** In a channel: this agent muted it. Absent: not known to have (agentsMutedChannel). */
  mutedChannel?: true;
};

export type PeerReadSummary = {
  peerCount: number;
  readCountAtSeq: Array<{ seq: number; count: number }>;
};

export type ReadReceiptScope =
  | { kind: "peers"; peers: PeerReadState[] }
  | { kind: "summary"; summary: PeerReadSummary };

export type ScopeReadUpdated =
  | {
      scopeId: string;
      peerKind: ReadReceiptPeerKind;
      peerId: string;
      maxReadSeq: number;
    }
  | { scopeId: string; summaryChanged: true };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object";
}

function normalizeSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function normalizeReadReceiptHydrate(payload: unknown): ReadReceiptScope | null {
  if (!isRecord(payload)) return null;
  if ("peerReadStates" in payload && "peerReadSummary" in payload) return null;

  if (Array.isArray(payload.peerReadStates)) {
    const peers: PeerReadState[] = [];
    const seen = new Set<string>();
    for (const item of payload.peerReadStates) {
      if (!isRecord(item)) return null;
      const peerKind = item.peerKind;
      const peerId = item.peerId;
      const maxReadSeq = normalizeSeq(item.maxReadSeq);
      if (
        (peerKind !== "human" && peerKind !== "agent")
        || typeof peerId !== "string"
        || peerId.length === 0
        || maxReadSeq === null
      ) return null;
      const key = `${peerKind}:${peerId}`;
      if (seen.has(key)) return null;
      seen.add(key);
      peers.push({
        peerKind,
        peerId,
        maxReadSeq,
        ...(item.stoppedFollowing === true ? { stoppedFollowing: true as const } : {}),
        ...(item.mutedChannel === true ? { mutedChannel: true as const } : {}),
      });
    }
    return { kind: "peers", peers };
  }

  if (isRecord(payload.peerReadSummary)) {
    const peerCount = normalizeCount(payload.peerReadSummary.peerCount);
    const rows = payload.peerReadSummary.readCountAtSeq;
    if (peerCount === null || !Array.isArray(rows)) return null;
    const readCountAtSeq: PeerReadSummary["readCountAtSeq"] = [];
    let previousSeq = -1;
    let previousCount = peerCount + 1;
    for (const row of rows) {
      if (!isRecord(row)) return null;
      const seq = normalizeSeq(row.seq);
      const count = normalizeCount(row.count);
      if (
        seq === null
        || count === null
        || seq <= previousSeq
        || count > peerCount
        || count >= previousCount
      ) return null;
      readCountAtSeq.push({ seq, count });
      previousSeq = seq;
      previousCount = count;
    }
    return { kind: "summary", summary: { peerCount, readCountAtSeq } };
  }

  return null;
}

export function normalizeScopeReadUpdated(payload: unknown): ScopeReadUpdated | null {
  if (!isRecord(payload) || typeof payload.scopeId !== "string" || payload.scopeId.length === 0) {
    return null;
  }
  if (payload.summaryChanged === true) {
    return { scopeId: payload.scopeId, summaryChanged: true };
  }
  const maxReadSeq = normalizeSeq(payload.maxReadSeq);
  if (
    (payload.peerKind !== "human" && payload.peerKind !== "agent")
    || typeof payload.peerId !== "string"
    || payload.peerId.length === 0
    || maxReadSeq === null
  ) return null;
  return {
    scopeId: payload.scopeId,
    peerKind: payload.peerKind,
    peerId: payload.peerId,
    maxReadSeq,
  };
}

export function mergePeerReadAdvance(
  scope: ReadReceiptScope | undefined,
  update: Exclude<ScopeReadUpdated, { summaryChanged: true }>,
): ReadReceiptScope | undefined {
  if (!scope || scope.kind !== "peers") return scope;
  const index = scope.peers.findIndex((peer) =>
    peer.peerKind === update.peerKind && peer.peerId === update.peerId
  );
  if (index < 0 || scope.peers[index].maxReadSeq >= update.maxReadSeq) return scope;
  const peers = scope.peers.slice();
  peers[index] = { ...peers[index], maxReadSeq: update.maxReadSeq };
  return { kind: "peers", peers };
}

/**
 * One `read_progress:updated` frame (agent_read_progress_v0; contract in
 * shared agentReadProgress.ts): the latest read position of every agent that
 * moved in one conversation. Null for a frame we cannot use; peers that are
 * malformed are dropped one by one, the rest still apply.
 */
export type ReadProgressUpdated = {
  scopeId: string;
  peers: Array<{ peerId: string; maxReadSeq: number }>;
};

export function normalizeReadProgressUpdated(payload: unknown): ReadProgressUpdated | null {
  if (!isRecord(payload) || typeof payload.scopeId !== "string" || payload.scopeId.length === 0) {
    return null;
  }
  if (!Array.isArray(payload.peers)) return null;
  const peers: ReadProgressUpdated["peers"] = [];
  for (const item of payload.peers) {
    if (!isRecord(item) || typeof item.peerId !== "string" || item.peerId.length === 0) continue;
    const maxReadSeq = normalizeSeq(item.maxReadSeq);
    if (maxReadSeq === null) continue;
    peers.push({ peerId: item.peerId, maxReadSeq });
  }
  return peers.length > 0 ? { scopeId: payload.scopeId, peers } : null;
}

/**
 * Apply a read-progress frame: agents only, only agents the hydrate exposed
 * (a frame never adds a peer), and only forward, like mergePeerReadAdvance.
 * The scope object is returned unchanged when nothing moved.
 */
export function mergeReadProgressPeers(
  scope: ReadReceiptScope | undefined,
  update: ReadProgressUpdated,
): ReadReceiptScope | undefined {
  if (!scope || scope.kind !== "peers") return scope;
  let peers: PeerReadState[] | null = null;
  for (const advance of update.peers) {
    const current = peers ?? scope.peers;
    const index = current.findIndex((peer) =>
      peer.peerKind === "agent" && peer.peerId === advance.peerId
    );
    if (index < 0 || current[index].maxReadSeq >= advance.maxReadSeq) continue;
    peers ??= scope.peers.slice();
    peers[index] = { ...peers[index], maxReadSeq: advance.maxReadSeq };
  }
  return peers ? { kind: "peers", peers } : scope;
}

export function mergeReadReceiptHydrate(
  current: ReadReceiptScope | undefined,
  hydrate: ReadReceiptScope,
): ReadReceiptScope {
  if (!current || current.kind !== "peers" || hydrate.kind !== "peers") return hydrate;
  const currentWatermarks = new Map(
    current.peers.map((peer) => [`${peer.peerKind}:${peer.peerId}`, peer.maxReadSeq]),
  );
  let changed = false;
  const peers = hydrate.peers.map((peer) => {
    const maxReadSeq = Math.max(
      peer.maxReadSeq,
      currentWatermarks.get(`${peer.peerKind}:${peer.peerId}`) ?? 0,
    );
    if (maxReadSeq === peer.maxReadSeq) return peer;
    changed = true;
    return { ...peer, maxReadSeq };
  });
  return changed ? { kind: "peers", peers } : hydrate;
}

/**
 * Read state for ONE specific agent peer — task #693 per-@mentioned-agent badge.
 *
 * Returns `null` for UNKNOWN rather than guessing "unread", because absence of
 * data is not evidence of not-read:
 *  - `summary` scopes carry only an aggregate count with no peer identity, so
 *    channels above `READ_RECEIPT_PEER_STATE_LIMIT` cannot answer per-agent;
 *  - a missing scope (not hydrated) or an agent that is not a peer is unknown.
 * Callers render nothing on `null`.
 */
export function projectAgentReadReceipt(
  scope: ReadReceiptScope | undefined,
  agentId: string,
  messageSeq: number | undefined,
): { read: boolean } | null {
  if (!scope || scope.kind !== "peers") return null;
  if (!Number.isSafeInteger(messageSeq) || (messageSeq ?? 0) <= 0) return null;
  if (!agentId) return null;
  const peer = scope.peers.find(
    (candidate) => candidate.peerKind === "agent" && candidate.peerId === agentId,
  );
  if (!peer) return null;
  return { read: peer.maxReadSeq >= messageSeq! };
}

export function projectReadReceipt(
  scope: ReadReceiptScope | undefined,
  messageSeq: number | undefined,
): { read: boolean; readCount: number; peerCount: number } {
  if (!scope || !Number.isSafeInteger(messageSeq) || (messageSeq ?? 0) <= 0) {
    return { read: false, readCount: 0, peerCount: 0 };
  }
  if (scope.kind === "peers") {
    const readCount = scope.peers.reduce(
      (count, peer) => count + (peer.maxReadSeq >= messageSeq! ? 1 : 0),
      0,
    );
    return { read: readCount > 0, readCount, peerCount: scope.peers.length };
  }
  let readCount = 0;
  for (const row of scope.summary.readCountAtSeq) {
    if (row.seq >= messageSeq!) {
      readCount = row.count;
      break;
    }
  }
  return { read: readCount > 0, readCount, peerCount: scope.summary.peerCount };
}
