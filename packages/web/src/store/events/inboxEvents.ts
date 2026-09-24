/**
 * Inbox domain events + reducer — the L2 exemplar of RFC 037.
 *
 * This module is the ONLY place inbox domain state may change. HTTP
 * responses and socket pushes are both converted into `InboxEvent`s by the
 * transport layer (L1) and applied here through `applyInboxEvent`.
 *
 * Layer contract: pure TypeScript. No React, no zustand, no api client, no
 * timers — enforced by the `store/events/**` oxlint override. The zustand
 * store wires this reducer in via a thin `dispatch` action (S1 wiring PR).
 *
 * Invariants (RFC 037 §2):
 *   I1 `patch` never performs I/O — it is a pure state transform.
 *   I2 events are idempotent: applying the same event twice equals once.
 *   I3 `reconcile` converges the state to the server snapshot it carries.
 *   I4 every apply returns a transition summary for the L5 trace hook.
 */

import {
  getInboxItemKey,
  isUnreadInboxFilter,
} from "../inboxStore";
import type {
  InboxFilter,
  InboxItem,
} from "../inboxStore";

/** The slice of inbox state the reducer owns. Mirrors (and will replace)
 *  the corresponding fields of `InboxState` when S1 wiring lands. */
export interface InboxDomainState {
  filter: InboxFilter;
  items: InboxItem[];
  hasMore: boolean;
  totalCount: number;
  totalUnreadCount: number;
}

/** HTTP window load (initial or pagination page). Server totals win. */
export interface InboxHydrateEvent {
  kind: "hydrate";
  filter: InboxFilter;
  /** `true` replaces the window (reset load), `false` appends a page. */
  reset: boolean;
  items: InboxItem[];
  hasMore: boolean;
  totalCount: number | null;
  totalUnreadCount: number | null;
}

/**
 * Local incremental transform (socket push or local intent). NO refetch.
 * S1 wiring converts `message:new` / `thread:updated` / read intents into
 * these payloads at the socket bridge / intent layer.
 */
export type InboxPatchEvent =
  | {
      kind: "patch";
      patch: "item-upsert";
      /** Fully-formed replacement/new row built by the transport adapter. */
      item: InboxItem;
      /** Monotonic per-item marker (e.g. latest message id/at) for I2 dedupe. */
      marker: string;
    }
  | {
      kind: "patch";
      patch: "item-read";
      itemKey: string;
    }
  | {
      kind: "patch";
      patch: "all-read";
    }
  | {
      kind: "patch";
      patch: "item-done";
      itemKey: string;
    };

/** Server-truth re-pull (reconnect / visibility regain / patch-miss). */
export interface InboxReconcileEvent {
  kind: "reconcile";
  filter: InboxFilter;
  items: InboxItem[];
  hasMore: boolean;
  totalCount: number | null;
  totalUnreadCount: number | null;
}

/** Filter switch (user intent). Clears the window; the wiring follows with a
 *  `hydrate` load for the new filter (same as today's setFilter semantics). */
export interface InboxFilterEvent {
  kind: "filter";
  filter: InboxFilter;
}

export type InboxEvent = InboxHydrateEvent | InboxPatchEvent | InboxReconcileEvent | InboxFilterEvent;

/** I4 — low-cardinality transition summary consumed by the trace hook. */
export interface InboxTransition {
  event: Exclude<InboxEvent["kind"], "patch"> | `patch:${InboxPatchEvent["patch"]}`;
  /** Rows touched by this event (0 = no-op, useful for I2 verification). */
  touched: number;
  totalUnreadDelta: number;
  /** True when a patch could not be applied locally (unknown item) and the
   *  caller should schedule a `reconcile` — the ONLY sanctioned path from
   *  patch to network, and it is a request the caller makes, not this module. */
  reconcileSuggested: boolean;
}

export interface InboxApplyResult {
  state: InboxDomainState;
  transition: InboxTransition;
}

/**
 * Derive an item's idempotence marker from the row itself (I2 without any
 * out-of-state memory — review fix for the module-Map purity violation,
 * PR #3993 Aiden/Bugen block). Adapters MUST construct `event.marker` by
 * this same rule; the contract is pinned by tests.
 *   channel/dm row  → lastMessageId
 *   thread row      → `${threadChannelId}:${lastReplyAt ?? replyCount}`
 *   mention_action  → id
 */
export function inboxItemMarker(item: InboxItem): string {
  if (item.kind === "thread") {
    return `${item.threadChannelId}:${item.lastReplyAt ?? item.replyCount}`;
  }
  if (item.kind === "mention_action") return item.id;
  return item.lastMessageId;
}

function dedupeByKey(items: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getInboxItemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function withServerTotals(
  merged: InboxItem[],
  totalCount: number | null,
  totalUnreadCount: number | null,
): Pick<InboxDomainState, "totalCount" | "totalUnreadCount"> {
  return {
    totalCount: totalCount == null ? merged.length : Math.max(0, Number(totalCount)),
    totalUnreadCount: totalUnreadCount == null
      ? merged.reduce((sum, item) => sum + item.unreadCount, 0)
      : Math.max(0, Number(totalUnreadCount)),
  };
}

function markItemRead(item: InboxItem): InboxItem {
  if (item.unreadCount === 0 && !item.hasMention) return item;
  return {
    ...item,
    unreadCount: 0,
    firstUnreadMessageId: null,
    hasMention: false,
  } as InboxItem;
}

/**
 * The single inbox state entrypoint. Pure: same (state, event) → same result.
 * Returns the next state plus the I4 transition summary; callers emit the
 * trace and, when `reconcileSuggested`, schedule an L1 reconcile pull.
 */
export function applyInboxEvent(
  state: InboxDomainState,
  event: InboxEvent,
): InboxApplyResult {
  switch (event.kind) {
    case "hydrate": {
      if (event.filter !== state.filter) {
        return noop(state, "hydrate");
      }
      const merged = dedupeByKey(event.reset ? event.items : [...state.items, ...event.items]);
      const totals = withServerTotals(merged, event.totalCount, event.totalUnreadCount);
      return {
        state: { ...state, items: merged, hasMore: event.hasMore, ...totals },
        transition: {
          event: "hydrate",
          touched: event.items.length,
          totalUnreadDelta: totals.totalUnreadCount - state.totalUnreadCount,
          reconcileSuggested: false,
        },
      };
    }

    case "reconcile": {
      if (event.filter !== state.filter) {
        return noop(state, "reconcile");
      }
      // Divergence oracle: this transition's totalUnreadDelta measures how
      // far local patch-accumulated state had drifted from server truth.
      // Non-zero on reconcile = a patch lied or was missed; the trace tap
      // makes it visible (test-pinned below in inboxEventsReducer.test.ts).
      const items = dedupeByKey(event.items);
      const totals = withServerTotals(items, event.totalCount, event.totalUnreadCount);
      return {
        state: { ...state, items, hasMore: event.hasMore, ...totals },
        transition: {
          event: "reconcile",
          touched: items.length,
          totalUnreadDelta: totals.totalUnreadCount - state.totalUnreadCount,
          reconcileSuggested: false,
        },
      };
    }

    case "filter": {
      if (event.filter === state.filter) return noop(state, "filter");
      return {
        state: {
          ...state,
          filter: event.filter,
          items: [],
          hasMore: true,
          totalCount: 0,
          totalUnreadCount: 0,
        },
        transition: {
          event: "filter",
          touched: 1,
          totalUnreadDelta: -state.totalUnreadCount,
          reconcileSuggested: false,
        },
      };
    }

    case "patch":
      return applyPatch(state, event);
  }
}

function applyPatch(state: InboxDomainState, event: InboxPatchEvent): InboxApplyResult {
  switch (event.patch) {
    case "item-upsert": {
      const key = getInboxItemKey(event.item);
      const existingIndex = state.items.findIndex(
        (item) => getInboxItemKey(item) === key,
      );
      const previous = existingIndex >= 0 ? state.items[existingIndex] : null;
      // I2 via state itself: if the row already reflects this marker, the
      // event was applied before (first apply inserts the row, so a repeat
      // finds it). Pure — no memory outside (state, event).
      if (previous && inboxItemMarker(previous) === event.marker) {
        return noop(state, "patch:item-upsert");
      }
      // Unknown item under a non-"all" filter may legitimately belong to the
      // window; we cannot decide locally → surface it and suggest reconcile.
      if (!previous && state.filter !== "all" && state.filter !== "unread") {
        return { state, transition: {
          event: "patch:item-upsert", touched: 0, totalUnreadDelta: 0, reconcileSuggested: true,
        } };
      }
      const items = previous
        ? state.items.map((item, i) => (i === existingIndex ? event.item : item))
        : [event.item, ...state.items];
      const unreadDelta = event.item.unreadCount - (previous?.unreadCount ?? 0);
      return {
        state: {
          ...state,
          items,
          totalCount: previous ? state.totalCount : state.totalCount + 1,
          totalUnreadCount: Math.max(0, state.totalUnreadCount + unreadDelta),
        },
        transition: {
          event: "patch:item-upsert",
          touched: 1,
          totalUnreadDelta: unreadDelta,
          reconcileSuggested: false,
        },
      };
    }

    case "item-read": {
      const target = state.items.find((item) => getInboxItemKey(item) === event.itemKey);
      if (!target || target.unreadCount <= 0) return noop(state, "patch:item-read");
      const unreadDelta = -target.unreadCount;
      const items = isUnreadInboxFilter(state.filter)
        ? state.items.filter((item) => getInboxItemKey(item) !== event.itemKey)
        : state.items.map((item) =>
            getInboxItemKey(item) === event.itemKey ? markItemRead(item) : item,
          );
      return {
        state: {
          ...state,
          items,
          totalCount: isUnreadInboxFilter(state.filter) ? Math.max(0, state.totalCount - 1) : state.totalCount,
          totalUnreadCount: Math.max(0, state.totalUnreadCount + unreadDelta),
        },
        transition: {
          event: "patch:item-read",
          touched: 1,
          totalUnreadDelta: unreadDelta,
          reconcileSuggested: false,
        },
      };
    }

    case "all-read": {
      if (state.totalUnreadCount === 0) return noop(state, "patch:all-read");
      const touched = state.items.filter((item) => item.unreadCount > 0).length;
      const delta = -state.totalUnreadCount;
      return {
        state: {
          ...state,
          items: isUnreadInboxFilter(state.filter) ? [] : state.items.map(markItemRead),
          totalCount: isUnreadInboxFilter(state.filter) ? 0 : state.totalCount,
          totalUnreadCount: 0,
        },
        transition: {
          event: "patch:all-read",
          touched,
          totalUnreadDelta: delta,
          reconcileSuggested: false,
        },
      };
    }

    case "item-done": {
      const target = state.items.find((item) => getInboxItemKey(item) === event.itemKey);
      if (!target) return noop(state, "patch:item-done");
      return {
        state: {
          ...state,
          items: state.items.filter((item) => getInboxItemKey(item) !== event.itemKey),
          totalCount: Math.max(0, state.totalCount - 1),
          totalUnreadCount: Math.max(0, state.totalUnreadCount - target.unreadCount),
        },
        transition: {
          event: "patch:item-done",
          touched: 1,
          totalUnreadDelta: -target.unreadCount,
          reconcileSuggested: false,
        },
      };
    }
  }
}

function noop(state: InboxDomainState, event: InboxTransition["event"]): InboxApplyResult {
  return {
    state,
    transition: { event, touched: 0, totalUnreadDelta: 0, reconcileSuggested: false },
  };
}
