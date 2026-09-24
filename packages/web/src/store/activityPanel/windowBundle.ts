/**
 * task #364 S2 — the ONE place the Activity window's source is decided.
 *
 * The frozen rule (@赵梓淇): a window is served entirely from the sync core or
 * entirely from legacy, never spliced. The hazard is not hypothetical — in
 * `ThreadsInbox` the rows and the counts are read from two different places
 * (`v2SourceItems` for items, `activityGroups` for totals), so swapping only
 * the item source produces a window with core rows and legacy counts that looks
 * completely normal. A reviewer would see a list of 3 rows above a badge saying
 * 40 and have no field to point at.
 *
 * So the source discriminant, the items, and every count travel together in one
 * value that is built BEFORE either branch point. Downstream code reads
 * `bundle.items` and `bundle.groups`; it never re-decides the source, because
 * there is no second decision to make. Splicing is unrepresentable rather than
 * discouraged.
 */
import type { ActivityWindowAuthority, WindowAuthorityDenial } from "./windowAuthority";

export interface ActivityWindowInputs<TItem, TGroup> {
  items: ReadonlyArray<TItem>;
  groups: ReadonlyArray<TGroup>;
  totalCount: number;
  totalUnreadCount: number;
  hasMore: boolean;
  /**
   * Pagination is a property of the WHOLE window, so the cursor travels in the
   * bundle with everything else. A load-more that kept reading a legacy cursor
   * after the rows came from the core would page into a list the core never
   * had — the same splice, one interaction later.
   */
  nextCursor: string | null;
  complete: boolean;
}

/**
 * Projection-P2 conditions under which the panel cannot faithfully consume
 * the `all/main` core window.
 *
 * These are deliberately separate, exact reasons instead of one generic
 * "not ready" bucket. Every one names a different piece of legacy state that
 * the current core contract does not carry, so a denial points at the layer
 * that must change before the window can be eligible.
 */
export type ActivityProjectionEligibilityDenial =
  | "activity_view_not_active"
  | "activity_filter_not_all"
  | "activity_sort_not_desc"
  | "activity_search_not_empty"
  | "activity_channel_filter_active"
  | "activity_window_generation_missing"
  | "activity_legacy_only_overlay_present";

/**
 * Why the bundle fell back, including reasons the authority layer cannot have.
 *
 * Kept distinct from `WindowAuthorityDenial` on purpose: reporting a bundle
 * failure as `row_missing_latest_activity_seq` would be a lie, because that
 * frontier check already PASSED upstream to get here. A diagnostic that names
 * the wrong cause sends the next reader to the wrong layer.
 */
export type ActivityBundleDenial =
  | WindowAuthorityDenial
  | ActivityProjectionEligibilityDenial
  /** The core claimed a window it has not fully loaded; see below. */
  | "core_window_incomplete"
  /**
   * The core's window fields contradict each other. The fold accepts
   * `complete`, `hasMore`, `nextCursor` and `totalCount` field-by-field with no
   * cross-field invariant, so `complete: true` alone does not mean the loaded
   * rows ARE the whole result set.
   */
  | "core_window_incoherent"
  /** The core's rows could not be projected into panel items/groups. */
  | "core_projection_unavailable";

export type ActivityWindowBundle<TItem, TGroup> =
  | ({ source: "legacy"; reason: ActivityBundleDenial } & ActivityWindowInputs<TItem, TGroup>)
  | ({ source: "core"; activityVersion: string } & ActivityWindowInputs<TItem, TGroup>);

/**
 * Build the window bundle from the legacy inputs and the core's verdict.
 *
 * `projectCoreRows` turns core rows into the panel's item shape. It is passed
 * in rather than imported so this module stays free of panel types, but note
 * what it means: if projection cannot produce items, the whole window falls
 * back — a half-projected list is exactly the splice this exists to prevent.
 *
 * Groups are NOT carried over from legacy in the core branch. That is the whole
 * point: legacy groups describe the legacy row set, and pairing them with core
 * rows is the defect. A core window that cannot supply its own grouping is not
 * authoritative, so it degrades to legacy wholesale.
 */
export function buildActivityWindowBundle<TItem, TGroup>(input: {
  verdict: ActivityWindowAuthority;
  legacy: ActivityWindowInputs<TItem, TGroup>;
  projectCoreRows: (
    rows: ReadonlyArray<Record<string, unknown>>,
  ) => { items: ReadonlyArray<TItem>; groups: ReadonlyArray<TGroup> } | null;
}): ActivityWindowBundle<TItem, TGroup> {
  const { verdict, legacy, projectCoreRows } = input;

  if (verdict.authority !== "core") {
    return { source: "legacy", reason: verdict.reason, ...legacy };
  }

  // An INCOMPLETE core window cannot be grouped correctly, and grouping is not
  // optional here. `InboxGroupCount` is a server-owned facet over the whole
  // result set, not over the loaded page: with rows=1 but totalCount=40 and
  // more to fetch, any grouping derived from the page says 1 while the totals
  // say 40. That is internally inconsistent in the same way the legacy/core
  // splice is, just sourced entirely from the core — so it fails closed.
  //
  // Serving a paginated window from the core requires the core contract to
  // carry authoritative groups. Until it does, guessing from the current page
  // is not an acceptable substitute, and borrowing legacy's groups is the
  // forbidden shape.
  if (!verdict.complete) {
    return { source: "legacy", reason: "core_window_incomplete", ...legacy };
  }

  // `complete: true` is necessary but NOT sufficient. Nothing upstream enforces
  // agreement between these fields, so a window can claim completeness while
  // still advertising more pages, holding a cursor, or reporting a total that
  // does not match the rows in hand. Any of those means the loaded rows are not
  // the whole result set, and groups derived from them would describe a subset
  // while the totals describe everything — the same internal inconsistency as
  // the splice, sourced entirely from the core.
  const rowsAreTheWholeSet =
    verdict.hasMore === false
    && verdict.nextCursor === null
    && verdict.rows.length === verdict.totalCount;
  if (!rowsAreTheWholeSet) {
    return { source: "legacy", reason: "core_window_incoherent", ...legacy };
  }

  const projected = projectCoreRows(verdict.rows);
  if (!projected) {
    // Falling back whole is the only safe answer; keeping the rows and
    // borrowing legacy counts is the forbidden shape.
    return { source: "legacy", reason: "core_projection_unavailable", ...legacy };
  }

  return {
    source: "core",
    activityVersion: verdict.activityVersion,
    items: projected.items,
    groups: projected.groups,
    totalCount: verdict.totalCount,
    totalUnreadCount: verdict.totalUnreadCount,
    hasMore: verdict.hasMore,
    nextCursor: verdict.nextCursor,
    complete: verdict.complete,
  };
}
