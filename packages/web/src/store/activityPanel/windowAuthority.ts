/**
 * Activity panel — whole-window authority decision (task #364).
 *
 * The frozen rule (@赵梓淇): a query window is served **entirely** from the sync
 * core or **entirely** from legacy. Never spliced. Ordering, pagination and
 * totals are properties of a whole window, so taking rows from the core while
 * taking `hasMore` or `totalCount` from legacy produces a window that is
 * internally inconsistent in ways no single field check would reveal — a list
 * that claims 40 unread while showing 3 rows and a cursor that points into a
 * page the core never had.
 *
 * So this module answers ONE question atomically: *may the core serve this
 * window in full?* Every caller gets either a complete core-sourced window or a
 * verdict to use legacy wholesale. There is deliberately no partial return
 * shape — the type makes splicing unrepresentable rather than merely
 * discouraged.
 *
 * Fail-closed inputs, each with a reason it disqualifies the window:
 *
 * - scope absent from the core            → nothing to serve
 * - `repairPending`                       → the core itself says it is behind
 * - `activityVersion === null`            → no authoritative baseline yet
 * - any row missing canonical `latestActivitySeq` → task #361 Gate B1: the
 *   content frontier is the Done/read/reactivation authority. A row without it
 *   cannot be ordered or marked Done correctly, and `replyCount` must never
 *   substitute. Note that `isRow` in the shared domain does NOT check this
 *   field (it guards only what the fold dereferences), so the check has to live
 *   here at the authority boundary.
 *
 * Nothing here decides whether the panel is user-visible; that stays gated on
 * Gate B2. This module only computes whether the core COULD be authoritative.
 */

import { isUInt64String } from "@botiverse/raft-sync-core";
import type { ActivityDomainState } from "@botiverse/raft-sync-core";

/** Why a window may not be served from the core. */
export type WindowAuthorityDenial =
  /** The cutover gate is off or in shadow; the core may observe but not serve. */
  | "gate_closed"
  | "scope_absent"
  | "repair_pending"
  | "no_baseline"
  | "row_missing_latest_activity_seq";

/**
 * A complete, self-consistent window. Every field comes from the same fold
 * state; there is no variant that carries some of these and not others.
 */
export interface CoreAuthoritativeWindow {
  authority: "core";
  rows: ReadonlyArray<Record<string, unknown>>;
  nextCursor: string | null;
  hasMore: boolean;
  complete: boolean;
  totalCount: number;
  totalUnreadCount: number;
  activityVersion: string;
}

export interface LegacyWindow {
  authority: "legacy";
  reason: WindowAuthorityDenial;
}

export type ActivityWindowAuthority = CoreAuthoritativeWindow | LegacyWindow;

/** Canonical content frontier present and well-formed on every row. */
export function rowsCarryCanonicalFrontier(
  rows: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return rows.every((row) => isUInt64String(row.latestActivitySeq));
}

/**
 * Decide, atomically, whether the core may serve this whole window.
 *
 * `repairPending` comes from the core's own scope bookkeeping rather than from
 * anything this module infers — the core is the only thing that knows whether a
 * gap repair or re-snapshot is outstanding.
 */
export function decideActivityWindowAuthority(input: {
  state: ActivityDomainState | undefined;
  repairPending: boolean | undefined;
}): ActivityWindowAuthority {
  const { state, repairPending } = input;
  if (!state) return { authority: "legacy", reason: "scope_absent" };
  if (repairPending) return { authority: "legacy", reason: "repair_pending" };
  if (state.activityVersion === null) {
    return { authority: "legacy", reason: "no_baseline" };
  }

  const rows = state.rows as ReadonlyArray<Record<string, unknown>>;
  if (!rowsCarryCanonicalFrontier(rows)) {
    return { authority: "legacy", reason: "row_missing_latest_activity_seq" };
  }

  return {
    authority: "core",
    rows,
    nextCursor: state.nextCursor,
    hasMore: state.hasMore,
    complete: state.complete,
    totalCount: state.totalCount,
    totalUnreadCount: state.totalUnreadCount,
    activityVersion: state.activityVersion,
  };
}
