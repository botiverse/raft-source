/**
 * Activity panel — behind-gate sync-core consumer (task #364).
 *
 * Owns the single `SyncCore` instance for the Activity domain and is the ONLY
 * place server responses reach it. The translation layer (`ingress.ts`) turns
 * raw payloads into core inputs; this file decides which core ENTRY POINT each
 * one takes and keeps the core's own repair bookkeeping authoritative.
 *
 * This module does not itself read or write the panel's rendered state. Its
 * authority can reach S2's visible receiver only through the atomic projection
 * bundle, under gate `on` and the complete eligibility set. Mixing core-sourced
 * rows with legacy rows in one window is explicitly forbidden (@赵梓淇): a
 * window is served entirely from the core or entirely from legacy, never
 * spliced.
 *
 * Three invariants this file exists to hold, all of them entry-point choices
 * rather than payload shapes:
 *
 * 1. A live push takes `ingestFrame`, never `ingestDifference`. `ingestFrame`
 *    compares `seq` against `appliedSeq + 1` and stop-gates a gap; a difference
 *    declares its own range and is trusted. Routing a push through the latter
 *    silently skipped sequences (measured: seq 5 → push 7 applied as 7, seq 6
 *    lost with nothing recording it).
 *
 * 2. A `snapshotRequired` 409 routes BACK INTO the core's own path, so
 *    `requestSnapshot` / `repairPending` / `pendingRequests` stay accurate. A
 *    UI-level refetch would leave the core believing no repair is outstanding.
 *
 * 3. A `notModified` clears the outstanding request WITHOUT fabricating a
 *    frame. An empty frame is a real fold input and would advance the applied
 *    watermark; an empty `events: []` difference at the SAME watermark folds
 *    nothing and merely settles the request.
 */

import {
  ACTIVITY_DOMAIN,
  createActivityDomain,
  createSyncCore,
} from "@botiverse/raft-sync-core";
import type {
  ActivityDomainState,
  SyncCore,
  SyncIngestOutcome,
  SyncRequestDescription,
} from "@botiverse/raft-sync-core";
import {
  decideActivityWindowAuthority,
} from "./windowAuthority";
import type {
  ActivityWindowAuthority,
} from "./windowAuthority";
import {
  SnapshotRequiredError,
  differenceFromResponse,
  frameFromPushEvent,
  snapshotFromResponse,
} from "./ingress";

/** What the consumer did with a response, for callers and for teeth. */
export type ActivityIngestReport =
  | { kind: "snapshot"; outcome: SyncIngestOutcome }
  | { kind: "difference"; outcome: SyncIngestOutcome }
  | { kind: "notModified"; outcome: SyncIngestOutcome }
  | { kind: "push"; outcome: SyncIngestOutcome }
  | { kind: "snapshotRequired"; outcome: SyncIngestOutcome }
  /**
   * A well-formed response that does NOT correlate to a request this consumer
   * issued, or that correlates to one already superseded. Nothing is folded, no
   * request is cleared, and the cursor does not move.
   */
  | { kind: "ignoredUncorrelated"; requestId: string; reason: "unsolicited" | "superseded" };

export interface ActivityConsumer {
  /** `GET /activity/snapshot` body. */
  acceptSnapshot(raw: unknown): ActivityIngestReport;
  /**
   * `GET /activity/difference` body — either arm of the 200 union, or the 409.
   *
   * The 409 is handled HERE rather than thrown to the caller, because the
   * caller is not allowed to be the one that decides to re-snapshot.
   */
  acceptDifference(raw: unknown): ActivityIngestReport;
  /** A pushed `frame` / `readStateUpdated`. */
  acceptPush(raw: unknown): ActivityIngestReport;
  /**
   * Record that the host is issuing a request for this scope, returning the
   * `requestId` to put on the wire.
   *
   * The core's `clearScopeRequests` keys on SCOPE alone, so without this the
   * consumer has no way to tell a fresh response from a stale or unsolicited
   * one — and any of them could clear a newer outstanding repair and move the
   * cursor. Correlation has to be held here. (@赵梓淇 P1.)
   */
  issueRequest(scopeId: string, requestId: string): void;
  /** Declarative IO the core wants; the host drains this. */
  pendingRequests(): ReadonlyArray<SyncRequestDescription>;
  state(scopeId: string): ActivityDomainState | undefined;
  /**
   * Whether the core may serve this whole window, and if so the window itself.
   *
   * Atomic by construction: callers cannot obtain a partial core window, so
   * splicing core rows onto legacy totals is unrepresentable rather than merely
   * discouraged. `repairPending` is read from the core's own scope bookkeeping.
   */
  windowAuthority(scopeId: string): ActivityWindowAuthority;
  /** Exposed for teeth and for host diagnostics; not for rendering. */
  readonly core: SyncCore;
}

/** The core the panel uses when the host does not inject one (tests do). */
export function createActivitySyncCore(): SyncCore {
  // `SyncDomainConfig` is invariant in its state/event params, so a concrete
  // Activity domain is not assignable to the `unknown` form the config field
  // declares. The cast is confined to this one constructor.
  return createSyncCore({
    domains: [createActivityDomain() as unknown as Parameters<typeof createSyncCore>[0]["domains"][number]],
  });
}

export function createActivityConsumer(
  core: SyncCore = createActivitySyncCore(),
): ActivityConsumer {
  /**
   * The request this consumer most recently issued per scope. Only a response
   * bearing this exact id may settle it; a later `issueRequest` supersedes the
   * earlier one, so an in-flight older response arriving afterwards is dropped
   * rather than allowed to clear the newer repair.
   */
  const outstanding = new Map<string, string>();

  function correlate(
    scopeId: string,
    requestId: string,
  ): { ok: true } | { ok: false; reason: "unsolicited" | "superseded" } {
    const expected = outstanding.get(scopeId);
    if (expected === undefined) return { ok: false, reason: "unsolicited" };
    if (expected !== requestId) return { ok: false, reason: "superseded" };
    return { ok: true };
  }

  return {
    core,

    issueRequest(scopeId, requestId) {
      outstanding.set(scopeId, requestId);
    },

    acceptSnapshot(raw) {
      // Correlate BEFORE ingesting. A snapshot REPLACES the whole window, so an
      // unsolicited or stale-after-newer snapshot is the most destructive
      // uncorrelated response of the three: it would overwrite newer state
      // outright and leave the outstanding record dangling.
      const snapshot = snapshotFromResponse(raw);
      const check = correlate(snapshot.scopeId, snapshot.requestId);
      if (!check.ok) {
        return {
          kind: "ignoredUncorrelated",
          requestId: snapshot.requestId,
          reason: check.reason,
        };
      }
      outstanding.delete(snapshot.scopeId);
      return {
        kind: "snapshot",
        outcome: core.ingestSnapshot(ACTIVITY_DOMAIN, snapshot),
      };
    },

    acceptDifference(raw) {
      let plan;
      try {
        plan = differenceFromResponse(raw);
      } catch (error) {
        if (error instanceof SnapshotRequiredError) {
          // Invariant 2. Hand the verdict to the CORE rather than acting on it:
          // `ingestDifference` with `snapshotRequired` runs clearScopeRequests +
          // requestSnapshot and sets repairPending, so a subsequent
          // `pendingRequests()` drain actually asks for the snapshot. Doing the
          // refetch here instead would leave the core with repairPending=false
          // and no pending request — it would believe it was caught up.
          // Invariant 2b: the 409 must collapse to EXACTLY ONE snapshot repair.
          //
          // The server answers an old-epoch request with its CURRENT epoch. If
          // we forward that epoch, the core takes its `epochMismatch` branch —
          // which runs BEFORE the `snapshotRequired` branch and does NOT call
          // `clearScopeRequests`. Measured on the real sequence (epoch1 → gap
          // difference pending → 409 carrying epoch2): the stale
          // `difference(since=5, epoch=1)` survived alongside a new
          // `snapshot(epoch_mismatch)`, so the host would drain both.
          //
          // So the 409 is routed with the epoch WE currently hold, which is what
          // makes the core take the snapshotRequired branch and clear the scope.
          // This is not hiding the epoch change: the action for both cases is
          // identical — re-snapshot — and the snapshot response carries the new
          // epoch and rebaselines. The `epoch` field here selects a bookkeeping
          // path, it is not a claim about the server's epoch. (@赵梓淇 P1.)
          // Correlate FIRST. The previous order deleted `outstanding` and
          // queued a snapshot before any check, so an unsolicited or superseded
          // 409 could clear a newer repair — the fence existed for
          // difference/notModified only, not at every entry point.
          const check409 = correlate(error.scopeId, error.requestId);
          if (!check409.ok) {
            return {
              kind: "ignoredUncorrelated",
              requestId: error.requestId,
              reason: check409.reason,
            };
          }
          outstanding.delete(error.scopeId);
          const heldEpoch = core.scopeSyncState(ACTIVITY_DOMAIN, error.scopeId)?.epoch
            ?? error.epoch;
          return {
            kind: "snapshotRequired",
            outcome: core.ingestDifference(ACTIVITY_DOMAIN, {
              scopeId: error.scopeId,
              epoch: heldEpoch,
              fromSeq: error.watermark,
              toSeq: error.watermark,
              events: [],
              snapshotRequired: true,
            }),
          };
        }
        throw error;
      }

      if (plan.kind === "notModified") {
        // Correlation BEFORE any core call. An uncorrelated notModified must not
        // reach `clearScopeRequests` (it would wipe a newer repair) and must not
        // advance the cursor.
        const check = correlate(plan.scopeId, plan.requestId);
        if (!check.ok) {
          return {
            kind: "ignoredUncorrelated",
            requestId: plan.requestId,
            reason: check.reason,
          };
        }
        outstanding.delete(plan.scopeId);
        // Invariant 3. `events: []` means the fold is never called, and stamping
        // `toSeq` at the server's own watermark means `appliedSeq` cannot move
        // (the core only raises it when `toSeq > appliedSeq`). What this DOES do
        // is run `clearScopeRequests`, settling the difference request we made.
        return {
          kind: "notModified",
          outcome: core.ingestDifference(ACTIVITY_DOMAIN, {
            scopeId: plan.scopeId,
            epoch: plan.epoch,
            fromSeq: plan.watermark,
            toSeq: plan.watermark,
            events: [],
          }),
        };
      }

      const diffCheck = correlate(plan.response.scopeId, plan.requestId);
      if (!diffCheck.ok) {
        return {
          kind: "ignoredUncorrelated",
          requestId: plan.requestId,
          reason: diffCheck.reason,
        };
      }
      outstanding.delete(plan.response.scopeId);
      return {
        kind: "difference",
        outcome: core.ingestDifference(ACTIVITY_DOMAIN, plan.response),
      };
    },

    acceptPush(raw) {
      // Invariant 1. `ingestFrame`, not `ingestDifference`.
      return {
        kind: "push",
        outcome: core.ingestFrame(ACTIVITY_DOMAIN, frameFromPushEvent(raw)),
      };
    },

    pendingRequests() {
      return core.pendingRequests();
    },

    state(scopeId) {
      return core.state<ActivityDomainState>(ACTIVITY_DOMAIN, scopeId);
    },

    windowAuthority(scopeId) {
      return decideActivityWindowAuthority({
        state: core.state<ActivityDomainState>(ACTIVITY_DOMAIN, scopeId),
        repairPending: core.scopeSyncState(ACTIVITY_DOMAIN, scopeId)?.repairPending,
      });
    },
  };
}
