/**
 * Raft Sync Core — type seam (RFC 043).
 *
 * The core is a pure deterministic sync state machine: frames / snapshots /
 * difference responses in; domain state + declarative request descriptions
 * out. No transport, no persistence, no ambient clock or randomness — `now`
 * and ids are injected (RFC 043 §9.4). All IO leaves the core as
 * `SyncRequestDescription`s; retry timing/backoff belongs to the host
 * (§3 retry boundary).
 */

/** Scope identity within a domain (channel id, agent id, "me", …). */
export type SyncScopeId = string;

/**
 * Cross-domain scope identity used by child read caches. The three-segment
 * key is deliberately explicit: a child cache indexed by only messageId
 * cannot be invalidated mechanically when its parent scope rebaselines.
 */
export interface SyncScopeKey {
  serverId: string;
  scopeKind: string;
  scopeId: SyncScopeId;
}

/** Domain name — the RFC 037/038 domain the events belong to. */
export type SyncDomainName = string;

/**
 * Epoch discriminator (RFC 038 §3): watermarks are only comparable within
 * one epoch. A scope with no epoch yet uses `null` (pre-first-contact).
 */
export type SyncEpoch = string;

/**
 * Density is a property of the (scope, endpoint) pair — RFC 038 §9
 * correction. `contiguous` scopes gap-detect on seq+1 and stop-gate into
 * difference repair; `sparse` scopes only max-advance and repair via
 * repull (stop-gating forbidden).
 */
export type SyncDensity = "contiguous" | "sparse";

/**
 * Sequence position within a scope.
 *
 * `bigint`, not `number`: RFC 038 sequences are server `bigserial` values and
 * the Activity wire contract carries them as canonical decimal strings
 * precisely so values above 2^53 stay exact. Narrowing to a double makes
 * 9007199254740992 and 9007199254740993 the same position — adjacency, gap
 * detection and duplicate/conflict verdicts then all silently lie. Canonical
 * output remains a decimal string.
 */
export type SyncSeq = bigint;

/** A live push frame for one scope. Payload is the domain's event type. */
export interface SyncFrame<E = unknown> {
  scopeId: SyncScopeId;
  seq: SyncSeq;
  epoch: SyncEpoch | null;
  event: E;
}

/** A hydrate snapshot for one scope: state + the watermark it was taken at. */
export interface SyncSnapshot<S = unknown> {
  scopeId: SyncScopeId;
  watermark: SyncSeq;
  epoch: SyncEpoch | null;
  state: S;
}

/**
 * A difference response (RFC 038 §3.2). `snapshotRequired` is the server's
 * explicit verdict that the gap is unserviceable; `partial` marks a
 * differenceSlice-style page — the core must idempotently regenerate the
 * next request from the intermediate watermark (RFC 043 §9.6).
 */
export interface SyncDifferenceResponse<E = unknown> {
  scopeId: SyncScopeId;
  epoch: SyncEpoch | null;
  fromSeq: SyncSeq;
  toSeq: SyncSeq;
  events: ReadonlyArray<{ seq: SyncSeq; event: E }>;
  partial?: boolean;
  snapshotRequired?: boolean;
}

/** Per-scope bookkeeping the core maintains. */
export interface SyncScopeState {
  appliedSeq: SyncSeq;
  epoch: SyncEpoch | null;
  /** A repair (difference/snapshot) request is outstanding for this scope. */
  repairPending: boolean;
}

/**
 * Declarative IO: the core never performs requests, it describes them.
 * The host executes and feeds results back via ingest*. `holdHash` is the
 * hash of data the core already holds, enabling server NotModified
 * short-circuits (RFC 043 §5 hash layer); hosts that cannot hash pass
 * nothing and lose only efficiency.
 */
export type SyncRequestDescription =
  | {
      kind: "difference";
      domain: SyncDomainName;
      scopeId: SyncScopeId;
      sinceSeq: SyncSeq;
      epoch: SyncEpoch | null;
      holdHash?: string;
      /** Client-declared resnapshot threshold (RFC 043 §6). */
      resnapshotOverGap?: number;
    }
  | {
      kind: "snapshot";
      domain: SyncDomainName;
      scopeId: SyncScopeId;
      reason: "epoch_mismatch" | "snapshot_required" | "initial" | "sparse_repull";
      holdHash?: string;
    };

/**
 * Violation record — RFC 040 negative-space vocabulary, pure data so it
 * enters the cross-platform equivalence suite (RFC 043 §9.3). `index` is
 * assigned monotonically by the ring buffer.
 */
export type SyncViolationKind =
  | "producer_seq_conflict"
  | "cross_epoch_arrival"
  | "stale_flood"
  | "version_regression"
  | "producer_version_conflict";

export interface SyncViolationRecord {
  index: number;
  kind: SyncViolationKind;
  domain: SyncDomainName;
  scopeId: SyncScopeId;
  seq?: SyncSeq;
  epoch?: SyncEpoch | null;
  /** Closed-set diagnostic fields only — never raw payload (RFC 040 §3). */
  detail?: Readonly<Record<string, string | number | boolean>>;
}

/** Drain result — rollover is visible, never silent (RFC 043 §10.2 ruling). */
export interface SyncViolationDrain {
  records: ReadonlyArray<SyncViolationRecord>;
  /** Count of records lost to ring-buffer rollover since the last drain. */
  droppedCount: number;
  /** The index the next record will receive; hosts detect gaps by index. */
  nextIndex: number;
}

/**
 * Bounded ring buffer contract (canonical egress per §10.2; Dozy's half
 * implements this). `onViolation` is an optional doorbell — same record as
 * payload, wiring it is never required for correctness.
 */
export interface SyncViolationBuffer {
  push(record: Omit<SyncViolationRecord, "index">): SyncViolationRecord;
  /**
   * Resume-from semantics: `sinceIndex` is the first index the caller has
   * NOT seen (pass the previous drain's `nextIndex`); returned records have
   * `index >= sinceIndex`. Omitted = everything retained. `droppedCount` =
   * indexes lost to rollover between `sinceIndex` and the oldest retained.
   */
  drain(sinceIndex?: number): SyncViolationDrain;
  readonly capacity: number;
  onViolation?: (record: SyncViolationRecord) => void;
}

/**
 * Host-injected storage (RFC 043 §10.1 ruling: KV-with-versioned-values).
 * Prefix enumeration/deletion is a hard requirement (epoch rebaseline
 * cleanup); placement (memory/file) belongs to the host by key pattern.
 * The skeleton keeps state in-memory; storage lands with T4b persistence.
 */
export interface SyncStorageAdapter {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  listPrefix(prefix: string): ReadonlyArray<string>;
  deletePrefix(prefix: string): void;
}

/**
 * Domain registration: the pure fold plus density declaration. The fold is
 * RFC 037's hydrate/patch/reconcile applied to (state, event) — it must be
 * pure and total (unknown events fold to an unchanged state, never throw).
 */
export interface SyncDomainConfig<S = unknown, E = unknown> {
  name: SyncDomainName;
  density: SyncDensity;
  initialState: () => S;
  /**
   * Canonical fingerprint for versioned facts. When present, the core can
   * distinguish an idempotent same-version replay from a producer that reused
   * one version for different facts. The function must be pure and total.
   */
  eventFingerprint?: (event: E) => string;
  /** Apply one in-order event. Purity is a contract (§9.4). */
  fold: (state: S, event: E, frame: { scopeId: SyncScopeId; seq: SyncSeq }) => S;
  /** Replace state from a snapshot (rebaseline). */
  fromSnapshot: (snapshot: SyncSnapshot<unknown>) => S;
  /**
   * Optional same-watermark snapshot replacement rule. Sparse domains may
   * accept a live frame as a provisional baseline before an HTTP snapshot
   * arrives; when that snapshot carries a strictly richer projection at the
   * same watermark, the domain may replace the provisional state. Returning
   * false keeps the normal stale-snapshot no-op/violation behavior.
   */
  acceptSameWatermarkSnapshot?: (currentState: S, snapshot: SyncSnapshot<unknown>) => boolean;
}

export interface SyncCoreConfig {
  domains: ReadonlyArray<SyncDomainConfig<unknown, unknown>>;
  /** Injected clock — ambient wall-clock reads inside the core are a named finding. */
  now?: () => number;
  storage?: SyncStorageAdapter;
  violationBufferCapacity?: number;
}

/** Outcome of one ingest step — pure data, test-assertable. */
export type SyncIngestOutcome =
  | { kind: "applied"; scopeId: SyncScopeId; seq: SyncSeq }
  | { kind: "duplicate_dropped"; scopeId: SyncScopeId; seq: SyncSeq }
  | { kind: "gap_repair_requested"; scopeId: SyncScopeId; fromSeq: SyncSeq; toSeq: SyncSeq }
  | { kind: "max_advanced"; scopeId: SyncScopeId; seq: SyncSeq }
  | { kind: "epoch_rebaseline_requested"; scopeId: SyncScopeId }
  | { kind: "violation"; scopeId: SyncScopeId; violation: SyncViolationKind };

export interface SyncCore {
  ingestFrame(domain: SyncDomainName, frame: SyncFrame): SyncIngestOutcome;
  ingestSnapshot(domain: SyncDomainName, snapshot: SyncSnapshot): SyncIngestOutcome;
  ingestDifference(domain: SyncDomainName, response: SyncDifferenceResponse): SyncIngestOutcome;
  /** Declarative pending IO; drained by the host. Stable order, idempotent. */
  pendingRequests(): ReadonlyArray<SyncRequestDescription>;
  state<S = unknown>(domain: SyncDomainName, scopeId: SyncScopeId): S | undefined;
  scopeSyncState(domain: SyncDomainName, scopeId: SyncScopeId): SyncScopeState | undefined;
  violations(sinceIndex?: number): SyncViolationDrain;
}
