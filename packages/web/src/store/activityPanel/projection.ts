/**
 * task #364 Projection P1 — sync-core `ActivityRow` → the panel's `InboxItem`.
 *
 * Scope frozen by @赵梓淇. This is the inverse of the server's
 * `activitySyncService.normalizeRow`, and it is a PRODUCT mapping, not test
 * scaffolding: it decides what the user actually sees the moment the gate
 * flips — row titles, previews, unread counts, click targets. Getting it wrong
 * does not go red, it just shows the wrong thing. So every rule below is
 * fail-closed, and anything this module cannot represent faithfully returns
 * `null` so the existing bundle falls the WHOLE window back to legacy.
 *
 * 1. ONE row contract, ONE validator. Rows are narrowed by
 *    `narrowActivityRow` — the single compiled `ActivityRow.json` entry point
 *    that lives next to the ingress path's only Ajv instance. This module
 *    constructs no validator of its own.
 *
 *    It also consumes the GENERATED union rather than a bag of unknowns, so
 *    every field access below is compile-time checked against the contract.
 *    An earlier version narrowed to `Record<string, unknown>` and cast each
 *    field: Ajv would have accepted a changed schema while the stale accesses
 *    still typechecked, projecting `undefined` into a visible row. The union
 *    turns that same change into a build error. (@赵梓淇 P1.)
 *
 * 2. Pure inverse projection. `rowId` / `rowVersion` / `maxReadSeq` /
 *    `readStateVersion` are transport and read-state bookkeeping — NOT part of
 *    the panel row. Thread `isFollowing` is server-owned and projected exactly;
 *    `doneAt` / `unfollowedAt` remain absent because the core does not send
 *    those timestamps.
 *
 * 3. `mention_action` is never synthesised — it is not in the row contract, so
 *    one fabricated here would be a user-visible action the server never sent.
 *    The union makes that structurally impossible rather than merely avoided.
 */
import { narrowActivityRow } from "./ingress";
import type { NarrowedActivityRow } from "./ingress";
import {
  buildActivityWindowBundle,
} from "./windowBundle";
import type {
  ActivityProjectionEligibilityDenial,
  ActivityWindowBundle,
  ActivityWindowInputs,
} from "./windowBundle";
import type { ActivityWindowAuthority } from "./windowAuthority";

import {
  sortInboxGroupsByRecentActivity,
} from "../inboxStore";
import type {
  ActivitySortDirection,
  InboxFilter,
  InboxGroupCount,
  InboxItem,
} from "../inboxStore";

/**
 * Project ONE validated row.
 *
 * Exhaustive over the generated discriminant: adding a kind to the contract
 * makes this fail to compile rather than silently fall through.
 */
function projectRow(row: NarrowedActivityRow): InboxItem {
  if (row.type === "thread") {
    return {
      kind: "thread",
      threadChannelId: row.threadChannelId,
      parentMessageId: row.parentMessageId,
      parentChannelId: row.parentChannelId,
      parentChannelName: row.parentChannelName,
      parentChannelType: row.parentChannelKind,
      parentMessagePreview: row.parentMessagePreview,
      parentMessageSenderType: row.parentMessageSenderKind,
      parentMessageSenderId: row.parentMessageSenderId,
      latestActivityPreview: row.latestActivityPreview,
      latestActivitySenderType: row.latestActivitySenderKind,
      latestActivitySenderId: row.latestActivitySenderId,
      latestActivitySenderName: row.latestActivitySenderName,
      latestActivityMessageId: row.latestActivityMessageId,
      // The three-axis authority (task #361), carried byte-exact as the
      // canonical decimal string — never through a number, since it exceeds
      // 2^53.
      latestActivitySeq: row.latestActivitySeq,
      firstUnreadMessageId: row.firstUnreadMessageId,
      firstMentionMessageId: row.firstMentionMessageId,
      replyCount: row.replyCount,
      lastActivityAt: row.lastActivityAt,
      lastReplyAt: row.lastReplyAt,
      unreadCount: row.unreadCount,
      hasMention: row.hasMention,
      taskNumber: row.taskNumber,
      taskStatus: row.taskStatus,
      taskClaimedByName: row.taskClaimedByName,
      isFollowing: row.isFollowing,
      // unfollowedAt / doneAt deliberately ABSENT — see header.
    };
  }

  return {
    kind: row.type,
    channelId: row.channelId,
    channelName: row.channelName,
    channelType: row.channelKind,
    lastMessageId: row.lastMessageId,
    // Current staging requires the same-source content frontier on channel/DM
    // rows too (Gate B1). Keep the canonical decimal string byte-exact just as
    // on the thread arm; the P1 transplant predates that InboxItem requirement.
    latestActivitySeq: row.latestActivitySeq,
    firstUnreadMessageId: row.firstUnreadMessageId,
    firstMentionMessageId: row.firstMentionMessageId,
    lastMessageAt: row.lastActivityAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageSenderType: row.lastMessageSenderKind,
    lastMessageSenderId: row.lastMessageSenderId,
    lastMessageSenderName: row.lastMessageSenderName,
    unreadCount: row.unreadCount,
    hasMention: row.hasMention,
    // doneAt deliberately ABSENT: the row contract carries no done state, and
    // `doneAt: null` would assert "not done" rather than "unknown".
  };
}

/**
 * Project a whole core window's rows.
 *
 * ALL-OR-NOTHING: one row that fails the narrow returns null for the entire
 * set. A partially projected list is the splice the bundle exists to prevent —
 * the panel would show a subset of the core's rows beside the core's totals.
 *
 * An empty set projects to `[]`, never null: otherwise a legitimately empty
 * core window would be indistinguishable from a projection failure and would
 * fall back to legacy forever.
 */
export function projectActivityRows(
  rows: ReadonlyArray<unknown>,
): ReadonlyArray<InboxItem> | null {
  const items: InboxItem[] = [];
  for (const raw of rows) {
    const narrowed = narrowActivityRow(raw);
    if (!narrowed) return null;
    items.push(projectRow(narrowed));
  }
  return items;
}

/**
 * P2 — the complete projection produced from ONE set of validated core rows.
 *
 * Groups are derived only from the projected rows. They never borrow the
 * legacy `/channels/inbox` facets: doing that would pair a core list with
 * counts for a different row set, which is precisely the mixed window this
 * task exists to make unrepresentable.
 */
export type ProjectedActivityWindow = {
  items: ReadonlyArray<InboxItem>;
  groups: ReadonlyArray<InboxGroupCount>;
};

type ProjectedGroupSource = {
  channelId: string;
  channelName: string;
  channelType: InboxGroupCount["channelType"];
  lastActivityAt: string;
};

function groupSourceForItem(item: InboxItem): ProjectedGroupSource | null {
  if (item.kind === "mention_action") return null;
  if (item.kind === "thread") {
    return {
      channelId: item.parentChannelId,
      channelName: item.parentChannelName,
      channelType: item.parentChannelType,
      lastActivityAt: item.lastActivityAt,
    };
  }
  return {
    channelId: item.channelId,
    channelName: item.channelName,
    channelType: item.channelType,
    lastActivityAt: item.lastMessageAt,
  };
}

/**
 * Aggregate the server-owned group facet from the SAME complete row set.
 *
 * A channel id must carry one coherent name/type across the window. Choosing
 * the first value when two rows disagree would silently invent which snapshot
 * won, so metadata disagreement fails the whole projection closed.
 */
function projectActivityGroups(
  items: ReadonlyArray<InboxItem>,
): ReadonlyArray<InboxGroupCount> | null {
  const byChannel = new Map<string, {
    group: InboxGroupCount & { lastActivityAt: string };
    lastActivityMs: number;
  }>();

  for (const item of items) {
    const source = groupSourceForItem(item);
    if (!source) return null;
    const lastActivityMs = Date.parse(source.lastActivityAt);
    if (!Number.isFinite(lastActivityMs)) return null;

    const existing = byChannel.get(source.channelId);
    if (!existing) {
      byChannel.set(source.channelId, {
        group: {
          channelId: source.channelId,
          channelName: source.channelName,
          channelType: source.channelType,
          count: 1,
          lastActivityAt: source.lastActivityAt,
        },
        lastActivityMs,
      });
      continue;
    }

    if (
      existing.group.channelName !== source.channelName
      || existing.group.channelType !== source.channelType
    ) {
      return null;
    }

    existing.group.count += 1;
    if (lastActivityMs > existing.lastActivityMs) {
      existing.group.lastActivityAt = source.lastActivityAt;
      existing.lastActivityMs = lastActivityMs;
    }
  }

  return sortInboxGroupsByRecentActivity(
    Array.from(byChannel.values(), ({ group }) => group),
  );
}

/** Project rows and their complete-window groups as one all-or-nothing value. */
export function projectActivityWindow(
  rows: ReadonlyArray<unknown>,
): ProjectedActivityWindow | null {
  const items = projectActivityRows(rows);
  if (!items) return null;
  const groups = projectActivityGroups(items);
  if (!groups) return null;
  return { items, groups };
}

export type ActivityPanelView = "active" | "saved" | "done";

/** One accepted legacy-window snapshot paired with its generation. */
export interface ActivityLegacyProjectionSnapshot {
  generation: string;
  window: ActivityWindowInputs<InboxItem, InboxGroupCount>;
}

export interface ActivityPanelProjectionInput {
  verdict: ActivityWindowAuthority;
  legacySnapshot: ActivityLegacyProjectionSnapshot;
  activityView: ActivityPanelView;
  filter: InboxFilter;
  sortDirection: ActivitySortDirection;
  searchQuery: string;
  channelFilterId: string | null;
}

function legacyOnlyOverlayPresent(items: ReadonlyArray<InboxItem>): boolean {
  return items.some((item) => {
    // `all` means all rows represented by the core contract; it must never be
    // read as permission to include a local action arm the contract does not
    // have. Keep an explicit allowlist so a future legacy kind also fails
    // closed until it earns a contract mapping.
    if (item.kind !== "channel" && item.kind !== "dm" && item.kind !== "thread") {
      return true;
    }
    return item.kind === "thread" && item.unfollowedAt != null;
  });
}

/**
 * The sole P2 eligibility decision. It is intentionally private: S2's visible
 * receiver consumes `buildActivityPanelWindowBundle` rather than asking these
 * questions again and creating a second source decision.
 */
function projectionEligibilityDenial(
  input: ActivityPanelProjectionInput,
): ActivityProjectionEligibilityDenial | null {
  const { legacySnapshot } = input;

  if (input.activityView !== "active") return "activity_view_not_active";
  if (input.filter !== "all") return "activity_filter_not_all";
  if (input.sortDirection !== "desc") return "activity_sort_not_desc";
  // Whitespace is still a real query on the legacy endpoint. Trimming it here
  // would claim the unfiltered all/main core window represents a different
  // request.
  if (input.searchQuery !== "") return "activity_search_not_empty";
  if (input.channelFilterId !== null) return "activity_channel_filter_active";
  if (legacySnapshot.generation === "") return "activity_window_generation_missing";
  if (legacyOnlyOverlayPresent(legacySnapshot.window.items)) {
    return "activity_legacy_only_overlay_present";
  }
  return null;
}

/**
 * P2/S2 boundary: eligibility, projection, groups, and authority collapse to
 * ONE whole-window bundle. `ThreadsInbox` reaches it only through the lazy
 * receiver, keeping the heavy projection graph out of the startup chunk.
 */
export function buildActivityPanelWindowBundle(
  input: ActivityPanelProjectionInput,
): ActivityWindowBundle<InboxItem, InboxGroupCount> {
  const denial = projectionEligibilityDenial(input);
  if (denial) {
    return { source: "legacy", reason: denial, ...input.legacySnapshot.window };
  }

  return buildActivityWindowBundle({
    verdict: input.verdict,
    legacy: input.legacySnapshot.window,
    projectCoreRows: projectActivityWindow,
  });
}
