import type { InboxScopeReadFrontier } from "@botiverse/raft-shared";
// This file is on the STARTUP path, so it consumes the uint64 primitive from
// its own narrow module rather than the barrel.
//
// Measured: the fix for the #632 C1 regression (carrier `cdc8e7c90`) is moving
// the primitive OUT of `domains/activity.ts`; once it lives in `uint64.ts` the
// barrel import builds green too, because the bundler no longer has to retain
// the Activity domain to reach it. The narrow import is therefore belt-and-
// braces, not the load-bearing part — it keeps the startup path's dependency
// explicit so a future heavy addition to the barrel cannot quietly re-enter
// this closure.
import { isUInt64String } from "@botiverse/raft-sync-core/src/uint64.js";
import { registerServerReset } from "./serverResetRegistry";

// #632 C0 — read-state ingress FAILURE OBSERVABILITY. Deliberately nothing more.
//
// Scope is pure observability (frozen by @赵梓淇 2026-07-31 after @artin's
// first-principles push):
//   - the existing legal-number path behaves EXACTLY as before;
//   - a rejected value emits a stable reason instead of vanishing;
//   - a rejected value never reaches the accepted map or a frame;
//   - one bad entry in a bulk payload must not drop the good ones.
//
// This does NOT add string authority, does NOT convert canonical strings, and
// does NOT fix >2^53 fidelity or the #632 read/unread reconciliation. Those
// need real `seq` magnitude data first, which nobody has produced.
//
// Why observability alone is still worth shipping: today a rejected payload is
// dropped by a bare `return null` / `.filter()`. Read state then stops
// advancing with no error and no telemetry, and the symptom — "unread never
// clears" — is indistinguishable from the #632 bug itself. That makes a future
// breakage undiagnosable, which is the expensive part.
export type ReadStateIngressCorruptReason =
  | "not_an_object"
  | "scope_id_invalid"
  | "max_read_seq_invalid"
  | "read_state_version_invalid"
  | "server_id_invalid"
  | "scopes_not_an_array";

export type ReadStateIngressCorruption = {
  field: "scopeId" | "maxReadSeq" | "readStateVersion" | "serverId" | "payload";
  reason: ReadStateIngressCorruptReason;
};

// `=> void` alone would ACCEPT an async listener and silently discard its
// Promise: a rejection then escapes try/catch and surfaces next tick as an
// unhandledRejection, which kills the process. Both failure shapes must be
// absorbed here. Same contract as `makeInboxScopeReadFrontier`'s onCorrupt.
type ReadStateIngressCorruptListener = (
  corruption: ReadStateIngressCorruption,
) => void | PromiseLike<void>;
const readStateIngressCorruptListeners = new Set<ReadStateIngressCorruptListener>();

export function registerReadStateIngressCorruptListener(listener: ReadStateIngressCorruptListener) {
  readStateIngressCorruptListeners.add(listener);
  return () => readStateIngressCorruptListeners.delete(listener);
}

function reportReadStateIngressCorrupt(
  field: ReadStateIngressCorruption["field"],
  reason: ReadStateIngressCorruptReason,
): null {
  const corruption: ReadStateIngressCorruption = { field, reason };
  // An observability sink must not become a failure source for the system it
  // observes: isolate each listener against BOTH failure shapes — a synchronous
  // throw, AND a returned/rejected thenable from an async listener (which
  // try/catch cannot see and which would otherwise kill the process next tick).
  for (const listener of readStateIngressCorruptListeners) {
    try {
      const result = listener(corruption);
      if (result && typeof (result as PromiseLike<void>).then === "function") {
        void Promise.resolve(result).catch(() => {
          // Swallowed by contract; the rejection verdict is not ingress's problem.
        });
      }
    } catch {
      // Swallowed by contract; a broken sink must not take down read-state ingress.
    }
  }
  console.warn("[readStateSync] read_state_ingress_corrupt", corruption);
  return null;
}

type ChannelReadListener = (channelId: string) => void;
export type PersistedChannelRead = {
  channelId: string;
  serverId: string | null;
  serverEpoch: number;
  principalId: string | null;
};
type PersistedChannelReadListener = (read: PersistedChannelRead) => void;
type ReadStateProjectionListener = (serverId: string, scopeId: string, projection: ReadStateProjection) => void;

const channelReadListeners = new Set<ChannelReadListener>();
const persistedChannelReadListeners = new Set<PersistedChannelReadListener>();
const acceptedReadStates = new Map<string, { maxReadSeq: number; readStateVersion: number; generation: number }>();
const acceptedReadStateProjections = new Map<string, ReadStateProjection>();
const readStateProjectionListeners = new Set<ReadStateProjectionListener>();
let acceptedReadStateGeneration = 0;

export type ReadStateUpdate = {
  serverId: string;
  scopeId: string;
  maxReadSeq: number;
  readStateVersion: number;
};

export type ReadStateApplyResult = "accepted" | "stale";
type ReadStateScope = Omit<ReadStateUpdate, "serverId">;

export interface ReadStateProjection {
  unreadCount: number;
  hasMention: boolean;
  firstUnreadMessageId: string | null;
  firstMentionMessageId: string | null;
  complete: boolean;
}

function readStateKey(serverId: string, scopeId: string): string {
  return `${serverId}:${scopeId}`;
}

export function notifyChannelReadLocally(channelId: string) {
  for (const listener of channelReadListeners) {
    listener(channelId);
  }
}

export function registerChannelReadListener(listener: ChannelReadListener) {
  channelReadListeners.add(listener);
  return () => channelReadListeners.delete(listener);
}

export function notifyChannelReadPersistedLocally(read: PersistedChannelRead) {
  for (const listener of persistedChannelReadListeners) {
    listener(read);
  }
}

export function registerPersistedChannelReadListener(listener: PersistedChannelReadListener) {
  persistedChannelReadListeners.add(listener);
  return () => persistedChannelReadListeners.delete(listener);
}

export function registerReadStateProjectionListener(listener: ReadStateProjectionListener) {
  readStateProjectionListeners.add(listener);
  // Stryker disable next-line ArrowFunction: unsubscribe identity is lifecycle glue; projection listener behavior is covered by inbox/thread integration tests.
  return () => readStateProjectionListeners.delete(listener);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

// Accepts exactly what it accepted before this change — the observability is
// added on the REJECTION paths only, so no legal payload changes behaviour.
function normalizeReadStateScope(payload: unknown): ReadStateScope | null {
  if (!payload || typeof payload !== "object") return reportReadStateIngressCorrupt("payload", "not_an_object");
  const { scopeId, maxReadSeq, readStateVersion } = payload as Record<string, unknown>;
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    return reportReadStateIngressCorrupt("scopeId", "scope_id_invalid");
  }
  if (!isNonNegativeSafeInteger(maxReadSeq)) {
    return reportReadStateIngressCorrupt("maxReadSeq", "max_read_seq_invalid");
  }
  if (!isNonNegativeSafeInteger(readStateVersion)) {
    return reportReadStateIngressCorrupt("readStateVersion", "read_state_version_invalid");
  }
  return { scopeId, maxReadSeq, readStateVersion };
}

export function normalizeReadStateUpdated(payload: unknown): ReadStateUpdate | null {
  const scope = normalizeReadStateScope(payload);
  if (!scope) return null;
  const { serverId } = payload as Record<string, unknown>;
  if (typeof serverId !== "string" || serverId.length === 0) {
    return reportReadStateIngressCorrupt("serverId", "server_id_invalid");
  }
  return { serverId, ...scope };
}

export function normalizeReadStateUpdatedBulk(payload: unknown): ReadStateUpdate[] {
  // The ENVELOPE needs its own reasons. Instrumenting only the per-scope path
  // leaves a whole rejection class silent — a malformed envelope drops every
  // scope it carried, which is strictly worse than one bad entry. Each envelope
  // rejection reports exactly once; per-entry isolation below is unchanged.
  if (!payload || typeof payload !== "object") {
    reportReadStateIngressCorrupt("payload", "not_an_object");
    return [];
  }
  const { serverId, scopes } = payload as Record<string, unknown>;
  if (typeof serverId !== "string" || serverId.length === 0) {
    reportReadStateIngressCorrupt("serverId", "server_id_invalid");
    return [];
  }
  if (!Array.isArray(scopes)) {
    reportReadStateIngressCorrupt("payload", "scopes_not_an_array");
    return [];
  }
  return scopes
    .map((scope) => {
      const normalized = normalizeReadStateScope(scope);
      return normalized ? { serverId, ...normalized } : null;
    })
    .filter((scope): scope is ReadStateUpdate => scope !== null);
}

export function consumeReadStateUpdate(update: ReadStateUpdate): ReadStateApplyResult {
  const key = readStateKey(update.serverId, update.scopeId);
  const previous = acceptedReadStates.get(key);
  if (previous && update.readStateVersion <= previous.readStateVersion) {
    return "stale";
  }

  acceptedReadStates.set(key, {
    maxReadSeq: update.maxReadSeq,
    readStateVersion: update.readStateVersion,
    generation: ++acceptedReadStateGeneration,
  });
  acceptedReadStateProjections.delete(key);
  return "accepted";
}

/**
 * Outcome of folding one authority HTTP snapshot into the read-state ledger.
 * `cleared` is distinct from `accepted`: it reports the server's authoritative
 * NEGATIVE fact (no cursor row), which is not the same as "read up to 0".
 */
export type ReadStateSnapshotOutcome =
  /**
   * `latestActivitySeq` is ROW EVIDENCE, not a ledger verdict.
   *
   * It is this row's own validated same-source frontier, and it is ORTHOGONAL
   * to whether the ledger accepted the version. A row can be perfectly good
   * evidence while being version-stale or generation-stale — the ledger just
   * already holds something newer. Collapsing those two facts into one null is
   * what let a completed row reappear: the suppression marker vanished purely
   * because the ledger had moved on.
   *
   * Null means the row genuinely carries no usable frontier: absent, corrupt,
   * a present union with a null pair, or a missing/invalid scope. A present
   * union whose maxReadSeq is invalid or out of safe range is corrupt as a
   * WHOLE — no cherry-picking a marker out of a bad union.
   */
  | { kind: "accepted"; latestActivitySeq: string | null }
  | { kind: "cleared"; latestActivitySeq: null }
  | { kind: "stale"; latestActivitySeq: string | null }
  | { kind: "corrupt"; latestActivitySeq: null };

/**
 * The SINGLE conversion point between the server's read-state union (#632 exit
 * 1, PR #5820) and this ledger. Every authority HTTP exit — `/channels`,
 * `/channels/dm`, `/channels/:id`, `/channels/unread`, `/channels/inbox` —
 * folds its per-scope union through here. Components never destructure the
 * union themselves, so there is exactly one place where the three kinds are
 * interpreted and exactly one place where a decimal string becomes a number.
 *
 * `maxReadSeq` is the only field that crosses type domains (canonical decimal
 * string on the wire, number in this ledger). It is parsed via BigInt and
 * converted only when it fits MAX_SAFE_INTEGER — an out-of-range value is
 * CORRUPT, never a truncated number, because a silently truncated frontier is
 * indistinguishable from a real one afterwards.
 *
 * `ledgerGenerationAtRequest` is how an in-flight response avoids rolling back
 * a socket frame that landed while it was in the air: pass the value of
 * `getReadStateLedgerGeneration()` captured before issuing the request.
 */
/**
 * The ONLY place a corrupt notification is delivered, and it is total.
 *
 * `(scopeId: string) => void` accepts an async function, so a rejecting sink
 * would escape a bare try/catch and surface as an unhandledRejection a tick
 * later. Both shapes are swallowed here: the corrupt verdict itself is the
 * signal, and a telemetry failure must never break the batch fold — that would
 * contradict "one corrupt scope does not poison the others".
 */
function notifyCorrupt(onCorrupt: ((scopeId: string) => void | PromiseLike<void>) | undefined, scopeId: string): void {
  if (!onCorrupt) return;
  try {
    const result = onCorrupt(scopeId);
    if (result && typeof (result as PromiseLike<void>).then === "function") {
      void Promise.resolve(result).catch(() => {
        // Swallowed by contract.
      });
    }
  } catch {
    // Swallowed by contract.
  }
}

export function consumeReadStateSnapshot(
  serverId: string | null | undefined,
  scopeId: string,
  frontier: InboxScopeReadFrontier,
  onCorrupt?: (scopeId: string) => void | PromiseLike<void>,
  opts?: { ledgerGenerationAtRequest?: number },
): ReadStateSnapshotOutcome {
  if (!serverId || !scopeId) return { kind: "stale", latestActivitySeq: null };

  const supersededBySocket =
    opts?.ledgerGenerationAtRequest !== undefined
    && hasAcceptedReadStateChangedAfter(serverId, scopeId, opts.ledgerGenerationAtRequest);

  if (frontier.kind === "corrupt") {
    // An alarm about the server's row — never evidence that the last good value
    // is wrong. Leave the ledger untouched so one bad scope cannot flip visible
    // unread state, and surface it value-free.
    notifyCorrupt(onCorrupt, scopeId);
    return { kind: "corrupt", latestActivitySeq: null };
  }

  const key = readStateKey(serverId, scopeId);

  if (frontier.kind === "absent") {
    if (supersededBySocket) return { kind: "stale", latestActivitySeq: null };
    if (!acceptedReadStates.has(key)) return { kind: "cleared", latestActivitySeq: null };
    acceptedReadStates.delete(key);
    acceptedReadStateProjections.delete(key);
    return { kind: "cleared", latestActivitySeq: null };
  }

  const raw = frontier.maxReadSeq;
  if (typeof raw !== "string" || !isUInt64String(raw)) {
    notifyCorrupt(onCorrupt, scopeId);
    return { kind: "corrupt", latestActivitySeq: null };
  }
  const parsed = BigInt(raw);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    notifyCorrupt(onCorrupt, scopeId);
    return { kind: "corrupt", latestActivitySeq: null };
  }

  // Both stale branches below sit AFTER the union passed validation, so the
  // row's evidence is good and travels even though the ledger stays untouched.
  const rowEvidence = frontier.latestActivity?.seq ?? null;
  if (supersededBySocket) return { kind: "stale", latestActivitySeq: rowEvidence };
  const previous = acceptedReadStates.get(key);
  if (previous && frontier.readStateVersion <= previous.readStateVersion) {
    return { kind: "stale", latestActivitySeq: rowEvidence };
  }

  acceptedReadStates.set(key, {
    maxReadSeq: Number(parsed),
    readStateVersion: frontier.readStateVersion,
    generation: ++acceptedReadStateGeneration,
  });
  acceptedReadStateProjections.delete(key);
  return { kind: "accepted", latestActivitySeq: frontier.latestActivity?.seq ?? null };
}

/**
 * Fold a batch of authority rows through the single adapter.
 *
 * Every authority HTTP exit calls THIS with the rows it just received, after
 * its own epoch/identity check and before the payload enters a domain reducer.
 * The union is read straight off the raw response — never recovered from a
 * reducer result, which would bind authority ingestion to whatever the domain
 * mapper happens to preserve.
 *
 * A row without a `readState` is skipped rather than treated as absent: an
 * older server (or an exit not yet emitting the union) must not be read as
 * "this scope has no cursor".
 */
export function consumeReadStateSnapshotRows(
  serverId: string | null | undefined,
  rows: readonly { scopeId: string; readState?: InboxScopeReadFrontier | null }[],
  opts?: { ledgerGenerationAtRequest?: number; onCorrupt?: (scopeId: string) => void | PromiseLike<void> },
): ReadStateSnapshotOutcome[] {
  // Same-order outcomes: callers normalise by INDEX against the rows they
  // passed, so the frontier stays bound to its own row without a key lookup —
  // no ledger-vs-row time-ordering invariant to prove.
  return rows.map((row) => {
    if (!serverId || !row.readState || !row.scopeId) {
      return { kind: "stale", latestActivitySeq: null } as const;
    }
    return consumeReadStateSnapshot(serverId, row.scopeId, row.readState, opts?.onCorrupt, {
      ledgerGenerationAtRequest: opts?.ledgerGenerationAtRequest,
    });
  });
}

export function getAcceptedReadState(serverId: string | null | undefined, scopeId: string): { maxReadSeq: number; readStateVersion: number } | null {
  // Stryker disable next-line ConditionalExpression: no-server is a defensive reset-time guard; normal server filtering is covered by other-server tests.
  if (!serverId) return null;
  return acceptedReadStates.get(readStateKey(serverId, scopeId)) ?? null;
}

export function getReadStateLedgerGeneration(): number {
  return acceptedReadStateGeneration;
}

export function hasAcceptedReadStateChangedAfter(serverId: string | null | undefined, scopeId: string, generation: number): boolean {
  // Stryker disable next-line ConditionalExpression: no-server is a defensive reset-time guard; normal server filtering is covered by other-server tests.
  if (!serverId) return false;
  return (acceptedReadStates.get(readStateKey(serverId, scopeId))?.generation ?? 0) > generation;
}

export function rememberAcceptedReadStateProjection(
  serverId: string | null | undefined,
  scopeId: string,
  readStateVersion: number,
  projection: ReadStateProjection,
) {
  if (!serverId || !projection.complete) return;
  const key = readStateKey(serverId, scopeId);
  const accepted = acceptedReadStates.get(key);
  // Stryker disable next-line ConditionalExpression,LogicalOperator: stale/absent projection storage is defensive; accepted fact publication is covered by hydrate/live tests.
  if (!accepted || accepted.readStateVersion !== readStateVersion) return;
  acceptedReadStateProjections.set(key, projection);
  for (const listener of readStateProjectionListeners) {
    listener(serverId, scopeId, projection);
  }
}

export function getAcceptedReadStateProjection(serverId: string | null | undefined, scopeId: string): ReadStateProjection | null {
  // Stryker disable next-line BooleanLiteral,ConditionalExpression: no-server is a defensive reset-time guard for hydration callers.
  if (!serverId) return null;
  // Stryker disable next-line LogicalOperator: null fallback is an API-shape guard; callers treat missing projections as no-op.
  return acceptedReadStateProjections.get(readStateKey(serverId, scopeId)) ?? null;
}

export function resetReadStateSyncForTests() {
  acceptedReadStates.clear();
  acceptedReadStateProjections.clear();
  acceptedReadStateGeneration = 0;
}

registerServerReset(() => {
  acceptedReadStates.clear();
  acceptedReadStateProjections.clear();
  acceptedReadStateGeneration = 0;
});
