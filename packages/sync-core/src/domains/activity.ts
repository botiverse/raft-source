import type { SyncDomainConfig, SyncScopeId, SyncSnapshot } from "../types.js";

/**
 * Activity domain (RFC 043 + the Activity Sync contract v1).
 *
 * Density is `contiguous`: Activity frames carry `seq` within an `epoch` and
 * the server exposes a difference endpoint, so gaps must stop-gate into repair
 * rather than silently max-advance.
 *
 * Everything here is pure and total. Unknown events fold to an unchanged state
 * (never throw) — that is a core contract, and it is also what lets a
 * fail-closed raw validator sit in front of this without the reducer needing
 * its own defensive parsing.
 */

export const ACTIVITY_DOMAIN = "activity";

// The uint64 primitives moved to `../uint64.js` so the read-state path can
// import them without pulling this whole domain into the web startup chunk
// (module-identity gate). Re-exported here so existing importers are unchanged.
import { compareUInt64String, isUInt64String, type UInt64String } from "../uint64.js";

export { compareUInt64String, isUInt64String, type UInt64String };

export type TombstoneReason = "done" | "deleted" | "outOfWindow";

/** Fields every Activity row carries, independent of row kind. */
export interface ActivityRowBase {
  rowId: string;
  rowVersion: UInt64String;
  lastActivityAt: string;
  unreadCount: number;
  hasMention: boolean;
  maxReadSeq: UInt64String;
  readStateVersion: UInt64String;
}

export type ActivityRow = ActivityRowBase & { type: string } & Record<string, unknown>;

export interface ActivityRowTombstone {
  rowId: string;
  rowVersion: UInt64String;
  reason: TombstoneReason;
}

/** One scope's folded Activity state. Row order is canonical, not incidental. */
export interface ActivityDomainState {
  /** Canonically ordered: most recent activity first. */
  rows: ReadonlyArray<ActivityRow>;
  /**
   * Retained tombstones, keyed by rowId. A tombstone is kept after deleting
   * its row so that a late out-of-order frame carrying an OLDER version of the
   * same row cannot resurrect it.
   */
  tombstones: Readonly<Record<string, UInt64String>>;
  activityVersion: UInt64String | null;
  nextCursor: string | null;
  hasMore: boolean;
  complete: boolean;
  totalCount: number;
  totalUnreadCount: number;
}

export type ActivityEvent =
  | {
      type: "frame";
      rows?: ReadonlyArray<unknown>;
      tombstones?: ReadonlyArray<unknown>;
      activityVersion?: unknown;
      nextCursor?: unknown;
      hasMore?: unknown;
      complete?: unknown;
      totalCount?: unknown;
      totalUnreadCount?: unknown;
    }
  | { type: "readStateUpdated"; updates?: ReadonlyArray<unknown>; activityVersion?: unknown }
  | { type: string; [key: string]: unknown };

export function initialActivityState(): ActivityDomainState {
  return {
    rows: [],
    tombstones: {},
    activityVersion: null,
    nextCursor: null,
    hasMore: false,
    complete: false,
    totalCount: 0,
    totalUnreadCount: 0,
  };
}

function isUnsignedCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

type ActivityFrameWindowFact = Pick<
  ActivityDomainState,
  "nextCursor" | "hasMore" | "complete" | "totalCount" | "totalUnreadCount"
>;

/**
 * Single accepted-fact projection for frame window metadata. Both the fold and
 * event fingerprint consume this object, so adding a state-bearing frame field
 * cannot silently update one path while remaining invisible to the other.
 */
function acceptedActivityFrameWindowFact(
  source: Record<string, unknown>,
): Partial<ActivityFrameWindowFact> {
  const accepted: Partial<ActivityFrameWindowFact> = {};
  if (source.nextCursor === null || typeof source.nextCursor === "string") {
    accepted.nextCursor = source.nextCursor;
  }
  if (typeof source.hasMore === "boolean") accepted.hasMore = source.hasMore;
  if (typeof source.complete === "boolean") accepted.complete = source.complete;
  if (isUnsignedCounter(source.totalCount)) accepted.totalCount = source.totalCount;
  if (isUnsignedCounter(source.totalUnreadCount)) {
    accepted.totalUnreadCount = source.totalUnreadCount;
  }
  return accepted;
}

function isRow(value: unknown): value is ActivityRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.rowId === "string" && row.rowId.length > 0
    && isUInt64String(row.rowVersion)
    // `maxReadSeq` and `readStateVersion` are REQUIRED by ActivityRowBase and
    // are dereferenced later by `foldReadStateUpdates` via compareUInt64String.
    // Validating only the four fields someone remembered let a partial row into
    // state, and the next legitimate `readStateUpdated` then threw a TypeError
    // on `undefined.length` — breaking the pure/total/never-throw contract this
    // reducer states, and diverging from KMP where the type cannot be absent.
    // A guard must cover every field the fold dereferences, not a remembered
    // subset of them. (@赵梓淇 on #5577 SOURCE.)
    && isUInt64String(row.maxReadSeq)
    && isUInt64String(row.readStateVersion)
    && typeof row.lastActivityAt === "string"
    && typeof row.type === "string";
}

function isTombstone(value: unknown): value is ActivityRowTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const stone = value as Record<string, unknown>;
  return typeof stone.rowId === "string" && stone.rowId.length > 0 && isUInt64String(stone.rowVersion);
}

/**
 * Canonical order: most recent activity first, then rowId as a total
 * tie-break.
 *
 * The tie-break is not cosmetic. Two rows sharing `lastActivityAt` is
 * ordinary (a batch write, or second-granularity timestamps), and without a
 * total order the two runners could emit different row sequences from the
 * same bytes and the cross-platform digest would disagree for no real reason.
 */
function compareRows(left: ActivityRow, right: ActivityRow): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return left.lastActivityAt < right.lastActivityAt ? 1 : -1;
  }
  if (left.rowId === right.rowId) return 0;
  return left.rowId < right.rowId ? -1 : 1;
}

function sortRows(rows: ReadonlyArray<ActivityRow>): ReadonlyArray<ActivityRow> {
  return [...rows].sort(compareRows);
}

/**
 * Apply rows and tombstones to a scope state.
 *
 * Version monotonicity is per-row and is the whole point: Activity frames can
 * arrive out of order relative to a snapshot or a difference page, so an older
 * `rowVersion` must never overwrite a newer one, and must never resurrect a
 * row that a newer tombstone removed.
 */
function applyRowsAndTombstones(
  state: ActivityDomainState,
  incomingRows: ReadonlyArray<unknown>,
  incomingTombstones: ReadonlyArray<unknown>,
): ActivityDomainState {
  const byId = new Map<string, ActivityRow>();
  for (const row of state.rows) byId.set(row.rowId, row);
  const tombstones: Record<string, UInt64String> = { ...state.tombstones };

  for (const candidate of incomingRows) {
    if (!isRow(candidate)) continue;
    const buried = tombstones[candidate.rowId];
    // A row only comes back if it is strictly newer than what killed it.
    if (buried !== undefined && compareUInt64String(candidate.rowVersion, buried) <= 0) continue;
    const existing = byId.get(candidate.rowId);
    if (existing && compareUInt64String(candidate.rowVersion, existing.rowVersion) <= 0) continue;
    if (buried !== undefined) delete tombstones[candidate.rowId];
    byId.set(candidate.rowId, candidate);
  }

  for (const candidate of incomingTombstones) {
    if (!isTombstone(candidate)) continue;
    const existing = byId.get(candidate.rowId);
    if (existing && compareUInt64String(candidate.rowVersion, existing.rowVersion) < 0) continue;
    const buried = tombstones[candidate.rowId];
    if (buried !== undefined && compareUInt64String(candidate.rowVersion, buried) <= 0) continue;
    byId.delete(candidate.rowId);
    tombstones[candidate.rowId] = candidate.rowVersion;
  }

  return { ...state, rows: sortRows([...byId.values()]), tombstones };
}

/**
 * `activityVersion` advances monotonically. A frame that carries an older
 * version (a delayed duplicate) must not drag it backwards — the host uses
 * this value to decide whether its view is current.
 */
function advanceActivityVersion(
  current: UInt64String | null,
  incoming: unknown,
): UInt64String | null {
  if (!isUInt64String(incoming)) return current;
  if (current === null) return incoming;
  return compareUInt64String(incoming, current) > 0 ? incoming : current;
}

function foldReadStateUpdates(
  state: ActivityDomainState,
  updates: ReadonlyArray<unknown>,
): ActivityDomainState {
  let changed = false;
  const rows = state.rows.map((row) => {
    const update = updates.find((candidate): candidate is Record<string, unknown> => {
      if (!candidate || typeof candidate !== "object") return false;
      return (candidate as Record<string, unknown>).scopeId === row.rowId;
    });
    if (!update) return row;
    if (!isUInt64String(update.readStateVersion) || !isUInt64String(update.maxReadSeq)) return row;
    // Read state is a versioned register: an older version is a stale echo.
    if (compareUInt64String(update.readStateVersion, row.readStateVersion) <= 0) return row;
    changed = true;
    return { ...row, maxReadSeq: update.maxReadSeq, readStateVersion: update.readStateVersion };
  });
  return changed ? { ...state, rows } : state;
}

export function foldActivityEvent(
  state: ActivityDomainState,
  event: ActivityEvent,
): ActivityDomainState {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return state;

  switch (event.type) {
    case "frame": {
      const withRows = applyRowsAndTombstones(
        state,
        Array.isArray(event.rows) ? event.rows : [],
        Array.isArray(event.tombstones) ? event.tombstones : [],
      );
      return {
        ...withRows,
        activityVersion: advanceActivityVersion(withRows.activityVersion, (event as Record<string, unknown>).activityVersion),
        ...acceptedActivityFrameWindowFact(event as Record<string, unknown>),
      };
    }
    case "readStateUpdated": {
      const updates = Array.isArray((event as Record<string, unknown>).updates)
        ? ((event as Record<string, unknown>).updates as ReadonlyArray<unknown>)
        : [];
      const withReads = foldReadStateUpdates(state, updates);
      return {
        ...withReads,
        activityVersion: advanceActivityVersion(withReads.activityVersion, (event as Record<string, unknown>).activityVersion),
      };
    }
    default:
      // Total by contract: an unrecognised event leaves state untouched.
      return state;
  }
}

function stateFromSnapshot(raw: unknown): ActivityDomainState {
  const base = initialActivityState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const source = raw as Record<string, unknown>;
  const window = (source.window && typeof source.window === "object" ? source.window : source) as Record<string, unknown>;

  const applied = applyRowsAndTombstones(
    base,
    Array.isArray(window.rows) ? window.rows : [],
    Array.isArray(window.tombstones) ? window.tombstones : [],
  );

  return {
    ...applied,
    // A snapshot REPLACES the baseline, so PRE-snapshot local tombstones do not
    // carry over — `applied` was folded onto an empty base, so they are already
    // gone. What remains in `applied.tombstones` is exactly what THIS snapshot
    // authoritatively carried, and it must be kept: clearing it let the very
    // next stale frame resurrect a row the server had just told us was deleted.
    tombstones: applied.tombstones,
    activityVersion: isUInt64String(source.activityVersion) ? source.activityVersion : null,
    nextCursor: typeof window.nextCursor === "string" ? window.nextCursor : null,
    hasMore: window.hasMore === true,
    complete: window.complete === true,
    totalCount: isUnsignedCounter(window.totalCount) ? window.totalCount : 0,
    totalUnreadCount: isUnsignedCounter(window.totalUnreadCount) ? window.totalUnreadCount : 0,
  };
}

/**
 * Deterministic serialisation for fingerprinting: object keys sorted, arrays
 * left in order. Local to the domain so the fold has no dependency on the
 * runner's canonicaliser.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Stable fingerprint so the core can tell an idempotent replay from a producer
 * conflict.
 *
 * It must cover the COMPLETE accepted fact, not just identity. Fingerprinting
 * only rowId/rowVersion means two same-seq frames carrying different
 * `unreadCount` (or different read-state updates) hash equal, so the second is
 * silently dropped as a duplicate and no violation is recorded — which is
 * precisely the producer conflict this fingerprint exists to surface.
 */
export function fingerprintActivityEvent(event: ActivityEvent): string {
  const source = event as Record<string, unknown>;
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const tombstones = Array.isArray(source.tombstones) ? source.tombstones : [];
  const updates = Array.isArray(source.updates) ? source.updates : [];
  const fact: unknown[] = [
    event.type,
    source.activityVersion ?? null,
    rows.filter(isRow).map((row) => stableStringify(row)),
    tombstones.filter(isTombstone).map((stone) => stableStringify(stone)),
    updates.map((update) => stableStringify(update)),
  ];
  if (event.type === "frame") fact.push(acceptedActivityFrameWindowFact(source));
  return stableStringify(fact);
}

export function encodeActivityScopeId(scope: {
  serverId: string;
  principalId: string;
  filter: string;
  windowId: string;
}): SyncScopeId {
  return JSON.stringify([scope.serverId, scope.principalId, scope.filter, scope.windowId]);
}

export function createActivityDomain(): SyncDomainConfig<ActivityDomainState, ActivityEvent> {
  return {
    name: ACTIVITY_DOMAIN,
    density: "contiguous",
    initialState: initialActivityState,
    eventFingerprint: fingerprintActivityEvent,
    fold: (state, event) => foldActivityEvent(state, event),
    fromSnapshot: (snapshot: SyncSnapshot<unknown>) => stateFromSnapshot(snapshot.state),
  };
}
