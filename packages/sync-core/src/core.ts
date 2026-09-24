/**
 * Raft Sync Core — deterministic sync state machine (RFC 043 §3).
 *
 * Pure with respect to IO: ingest functions fold data in; all outbound IO is
 * exposed as declarative `SyncRequestDescription`s. No transport, no
 * persistence, no ambient clock or randomness (RFC 043 §9.4). The same input
 * sequence, in any interleaving, yields the same terminal state.
 */
import { createSyncViolationBuffer } from "./violations.js";
import type {
  SyncCore,
  SyncCoreConfig,
  SyncDifferenceResponse,
  SyncDomainConfig,
  SyncDomainName,
  SyncEpoch,
  SyncFrame,
  SyncIngestOutcome,
  SyncRequestDescription,
  SyncScopeId,
  SyncScopeState,
  SyncSeq,
  SyncSnapshot,
  SyncViolationBuffer,
  SyncViolationDrain,
} from "./types.js";

interface ScopeEntry<S = unknown> {
  /** null = no baseline yet (pre-first-snapshot for contiguous scopes). */
  appliedSeq: SyncSeq | null;
  /** Fingerprint of the event accepted at appliedSeq, when the domain provides one. */
  acceptedFingerprint: string | null;
  epoch: SyncEpoch | null;
  repairPending: boolean;
  state: S;
}

export interface CreateSyncCoreOptions extends SyncCoreConfig {
  violationBuffer?: SyncViolationBuffer;
}

export function createSyncCore(config: CreateSyncCoreOptions): SyncCore {
  const domains = new Map<SyncDomainName, SyncDomainConfig<unknown, unknown>>();
  for (const domain of config.domains) domains.set(domain.name, domain);

  const scopes = new Map<SyncDomainName, Map<SyncScopeId, ScopeEntry>>();
  const violations =
    config.violationBuffer ??
    createSyncViolationBuffer({ capacity: config.violationBufferCapacity ?? 256 });
  /** Keyed by `${kind}:${domain}:${scopeId}` — requests are idempotent. */
  const pending = new Map<string, SyncRequestDescription>();

  function domainOf(name: SyncDomainName): SyncDomainConfig<unknown, unknown> {
    const domain = domains.get(name);
    if (!domain) throw new Error(`sync-core: unregistered domain "${name}"`);
    return domain;
  }

  function scopeEntry(domain: SyncDomainConfig<unknown, unknown>, scopeId: SyncScopeId): ScopeEntry {
    let byScope = scopes.get(domain.name);
    if (!byScope) {
      byScope = new Map();
      scopes.set(domain.name, byScope);
    }
    let entry = byScope.get(scopeId);
    if (!entry) {
      entry = {
        appliedSeq: null,
        acceptedFingerprint: null,
        epoch: null,
        repairPending: false,
        state: domain.initialState(),
      };
      byScope.set(scopeId, entry);
    }
    return entry;
  }

  function requestKey(request: SyncRequestDescription): string {
    return `${request.kind}:${request.domain}:${request.scopeId}`;
  }

  function requestSnapshot(
    domainName: SyncDomainName,
    scopeId: SyncScopeId,
    reason: Extract<SyncRequestDescription, { kind: "snapshot" }>["reason"],
  ): void {
    const request: SyncRequestDescription = { kind: "snapshot", domain: domainName, scopeId, reason };
    pending.set(requestKey(request), request);
  }

  function requestDifference(
    domainName: SyncDomainName,
    scopeId: SyncScopeId,
    sinceSeq: SyncSeq,
    epoch: SyncEpoch | null,
  ): void {
    const request: SyncRequestDescription = {
      kind: "difference",
      domain: domainName,
      scopeId,
      sinceSeq,
      epoch,
    };
    pending.set(requestKey(request), request);
  }

  function clearScopeRequests(domainName: SyncDomainName, scopeId: SyncScopeId): void {
    pending.delete(`difference:${domainName}:${scopeId}`);
    pending.delete(`snapshot:${domainName}:${scopeId}`);
  }

  function epochMismatch(entry: ScopeEntry, incoming: SyncEpoch | null): boolean {
    return entry.epoch !== null && incoming !== null && incoming !== entry.epoch;
  }

  return {
    ingestFrame(domainName, frame: SyncFrame): SyncIngestOutcome {
      const domain = domainOf(domainName);
      const entry = scopeEntry(domain, frame.scopeId);

      if (epochMismatch(entry, frame.epoch)) {
        violations.push({
          kind: "cross_epoch_arrival",
          domain: domainName,
          scopeId: frame.scopeId,
          seq: frame.seq,
          epoch: frame.epoch,
        });
        requestSnapshot(domainName, frame.scopeId, "epoch_mismatch");
        entry.repairPending = true;
        return { kind: "epoch_rebaseline_requested", scopeId: frame.scopeId };
      }

      // No baseline yet: contiguous scopes cannot order a lone frame — ask
      // for a snapshot; sparse scopes adopt the frame as their baseline.
      if (entry.appliedSeq === null) {
        if (domain.density === "contiguous") {
          requestSnapshot(domainName, frame.scopeId, "initial");
          entry.repairPending = true;
          return {
            kind: "gap_repair_requested",
            scopeId: frame.scopeId,
            fromSeq: 0n,
            toSeq: frame.seq,
          };
        }
        entry.state = domain.fold(entry.state, frame.event, { scopeId: frame.scopeId, seq: frame.seq });
        entry.appliedSeq = frame.seq;
        entry.acceptedFingerprint = domain.eventFingerprint?.(frame.event) ?? null;
        if (entry.epoch === null) entry.epoch = frame.epoch;
        return { kind: "max_advanced", scopeId: frame.scopeId, seq: frame.seq };
      }

      if (frame.seq < entry.appliedSeq) {
        if (domain.eventFingerprint) {
          violations.push({
            kind: "version_regression",
            domain: domainName,
            scopeId: frame.scopeId,
            seq: frame.seq,
            epoch: frame.epoch,
          });
        }
        return { kind: "duplicate_dropped", scopeId: frame.scopeId, seq: frame.seq };
      }

      // Same-version facts are duplicates only when the domain can prove
      // equality. A reused version carrying a different fact is a producer
      // violation and must never mutate accepted state.
      if (frame.seq === entry.appliedSeq) {
        if (!domain.eventFingerprint) {
          return { kind: "duplicate_dropped", scopeId: frame.scopeId, seq: frame.seq };
        }
        const incomingFingerprint = domain.eventFingerprint(frame.event);
        if (entry.acceptedFingerprint === incomingFingerprint) {
          return { kind: "duplicate_dropped", scopeId: frame.scopeId, seq: frame.seq };
        }
        violations.push({
          kind: "producer_version_conflict",
          domain: domainName,
          scopeId: frame.scopeId,
          seq: frame.seq,
          epoch: frame.epoch,
        });
        requestSnapshot(
          domainName,
          frame.scopeId,
          domain.density === "sparse" ? "sparse_repull" : "snapshot_required",
        );
        entry.repairPending = true;
        return { kind: "violation", scopeId: frame.scopeId, violation: "producer_version_conflict" };
      }

      if (domain.density === "sparse") {
        entry.state = domain.fold(entry.state, frame.event, { scopeId: frame.scopeId, seq: frame.seq });
        entry.appliedSeq = frame.seq;
        entry.acceptedFingerprint = domain.eventFingerprint?.(frame.event) ?? null;
        return { kind: "max_advanced", scopeId: frame.scopeId, seq: frame.seq };
      }

      // Contiguous density.
      if (frame.seq === entry.appliedSeq + 1n) {
        entry.state = domain.fold(entry.state, frame.event, { scopeId: frame.scopeId, seq: frame.seq });
        entry.appliedSeq = frame.seq;
        entry.acceptedFingerprint = domain.eventFingerprint?.(frame.event) ?? null;
        return { kind: "applied", scopeId: frame.scopeId, seq: frame.seq };
      }

      // Gap: stop-gate and request repair; the frame is NOT applied — the
      // difference response redelivers it in order (RFC 038 §4.1).
      const fromSeq = entry.appliedSeq + 1n;
      requestDifference(domainName, frame.scopeId, entry.appliedSeq, entry.epoch);
      entry.repairPending = true;
      return { kind: "gap_repair_requested", scopeId: frame.scopeId, fromSeq, toSeq: frame.seq - 1n };
    },

    ingestSnapshot(domainName, snapshot: SyncSnapshot): SyncIngestOutcome {
      const domain = domainOf(domainName);
      const entry = scopeEntry(domain, snapshot.scopeId);
      // A stale same-epoch snapshot is a comparison-based no-op — never a
      // rollback (convergence invariant; Tenny #4255 review). Cross-epoch
      // snapshots may lower the watermark: that is a rebaseline.
      const sameEpoch =
        entry.epoch === null || snapshot.epoch === null || snapshot.epoch === entry.epoch;
      const sameWatermark = entry.appliedSeq !== null && snapshot.watermark === entry.appliedSeq;
      const allowSameWatermark = sameWatermark
        && domain.acceptSameWatermarkSnapshot?.(entry.state, snapshot) === true;
      if (
        sameEpoch
        && entry.appliedSeq !== null
        && (snapshot.watermark < entry.appliedSeq || (sameWatermark && !allowSameWatermark))
      ) {
        violations.push({
          kind: "version_regression",
          domain: domainName,
          scopeId: snapshot.scopeId,
          seq: snapshot.watermark,
          epoch: snapshot.epoch,
        });
        return { kind: "duplicate_dropped", scopeId: snapshot.scopeId, seq: snapshot.watermark };
      }
      entry.state = domain.fromSnapshot(snapshot);
      entry.appliedSeq = snapshot.watermark;
      entry.acceptedFingerprint = null;
      entry.epoch = snapshot.epoch;
      entry.repairPending = false;
      clearScopeRequests(domainName, snapshot.scopeId);
      return { kind: "applied", scopeId: snapshot.scopeId, seq: snapshot.watermark };
    },

    ingestDifference(domainName, response: SyncDifferenceResponse): SyncIngestOutcome {
      const domain = domainOf(domainName);
      const entry = scopeEntry(domain, response.scopeId);

      if (epochMismatch(entry, response.epoch)) {
        violations.push({
          kind: "cross_epoch_arrival",
          domain: domainName,
          scopeId: response.scopeId,
          epoch: response.epoch,
        });
        requestSnapshot(domainName, response.scopeId, "epoch_mismatch");
        return { kind: "epoch_rebaseline_requested", scopeId: response.scopeId };
      }

      if (response.snapshotRequired) {
        clearScopeRequests(domainName, response.scopeId);
        requestSnapshot(domainName, response.scopeId, "snapshot_required");
        entry.repairPending = true;
        return { kind: "epoch_rebaseline_requested", scopeId: response.scopeId };
      }

      // bigint subtraction is not a valid comparator return; compare explicitly.
      const ordered = [...response.events].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      for (const item of ordered) {
        if (entry.appliedSeq !== null && item.seq <= entry.appliedSeq) continue;
        entry.state = domain.fold(entry.state, item.event, {
          scopeId: response.scopeId,
          seq: item.seq,
        });
        entry.appliedSeq = item.seq;
        entry.acceptedFingerprint = domain.eventFingerprint?.(item.event) ?? null;
      }
      if (entry.appliedSeq === null || response.toSeq > entry.appliedSeq) {
        entry.appliedSeq = response.toSeq;
        entry.acceptedFingerprint = null;
      }
      clearScopeRequests(domainName, response.scopeId);

      if (response.partial) {
        // differenceSlice loop (RFC 043 §9.6): idempotently regenerate the
        // next request from the intermediate watermark.
        requestDifference(domainName, response.scopeId, entry.appliedSeq, entry.epoch);
        return {
          kind: "gap_repair_requested",
          scopeId: response.scopeId,
          fromSeq: entry.appliedSeq + 1n,
          toSeq: response.toSeq,
        };
      }

      entry.repairPending = false;
      return { kind: "applied", scopeId: response.scopeId, seq: entry.appliedSeq };
    },

    pendingRequests(): ReadonlyArray<SyncRequestDescription> {
      // Stable order: insertion order of the keyed map — deterministic for
      // identical input histories.
      return [...pending.values()];
    },

    state<S = unknown>(domainName: SyncDomainName, scopeId: SyncScopeId): S | undefined {
      return scopes.get(domainName)?.get(scopeId)?.state as S | undefined;
    },

    scopeSyncState(domainName, scopeId): SyncScopeState | undefined {
      const entry = scopes.get(domainName)?.get(scopeId);
      if (!entry) return undefined;
      return {
        appliedSeq: entry.appliedSeq ?? 0n,
        epoch: entry.epoch,
        repairPending: entry.repairPending,
      };
    },

    violations(sinceIndex?: number): SyncViolationDrain {
      return violations.drain(sinceIndex);
    },
  };
}
