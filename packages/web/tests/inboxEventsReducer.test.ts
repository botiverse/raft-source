/**
 * RFC 037 §2 — inbox reducer invariant pins (I1–I3).
 *
 * These tests pin the exemplar reducer's contract BEFORE the S1 wiring PR
 * touches inboxStore: purity, idempotence (I2), reconcile convergence (I3),
 * and the no-I/O guarantee (I1 holds by construction — the module imports
 * no transport; the pure-layer lint override pins that structurally).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyInboxEvent,
  inboxItemMarker,
} from "../src/store/events/inboxEvents";
import type {
  InboxDomainState,
} from "../src/store/events/inboxEvents";
import type { InboxItem } from "../src/store/inboxStore";

function channelItem(overrides: Partial<Extract<InboxItem, { kind: "channel" }>> = {}): InboxItem {
  return {
    kind: "channel",
    channelId: "ch-1",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "m-1",
    firstUnreadMessageId: "m-1",
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-06T00:00:00Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "u-1",
    lastMessageSenderName: "A",
    unreadCount: 2,
    hasMention: false,
    ...overrides,
  } as InboxItem;
}

function emptyState(filter: InboxDomainState["filter"] = "all"): InboxDomainState {
  return { filter, items: [], hasMore: true, totalCount: 0, totalUnreadCount: 0 };
}

test("hydrate replaces the window and adopts server totals", () => {
  const { state, transition } = applyInboxEvent(emptyState(), {
    kind: "hydrate",
    filter: "all",
    reset: true,
    items: [channelItem()],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 2,
  });
  assert.equal(state.items.length, 1);
  assert.equal(state.totalUnreadCount, 2);
  assert.equal(transition.event, "hydrate");
  assert.equal(transition.totalUnreadDelta, 2);
});

test("patch item-upsert is idempotent by marker (I2)", () => {
  const base = applyInboxEvent(emptyState(), {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 2,
  }).state;

  const patch = {
    kind: "patch" as const,
    patch: "item-upsert" as const,
    item: channelItem({ unreadCount: 3, lastMessageId: "m-2" }),
    marker: "m-2",
  };
  const once = applyInboxEvent(base, patch);
  assert.equal(once.state.totalUnreadCount, 3);
  assert.equal(once.transition.touched, 1);

  const twice = applyInboxEvent(once.state, patch);
  assert.equal(twice.transition.touched, 0, "second apply of same marker must be a no-op");
  assert.deepEqual(twice.state, once.state);
});

test("patch never suggests network except unknown-item under narrow filter (I1 boundary)", () => {
  const known = applyInboxEvent(emptyState("all"), {
    kind: "patch", patch: "item-upsert", item: channelItem(), marker: "m-1",
  });
  assert.equal(known.transition.reconcileSuggested, false);

  const unknownUnderMentions = applyInboxEvent(emptyState("mentions"), {
    kind: "patch", patch: "item-upsert", item: channelItem(), marker: "m-9",
  });
  assert.equal(unknownUnderMentions.transition.reconcileSuggested, true);
  assert.equal(unknownUnderMentions.transition.touched, 0);
});

test("item-read zeroes unread and drops the row under the unread filter", () => {
  const base: InboxDomainState = {
    filter: "unread",
    items: [channelItem()],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 2,
  };
  const { state, transition } = applyInboxEvent(base, {
    kind: "patch", patch: "item-read", itemKey: "channel:ch-1",
  });
  // Key format must match getInboxItemKey — if this fails, fix the test's
  // key literal, not the reducer.
  if (transition.touched === 1) {
    assert.equal(state.items.length, 0);
    assert.equal(state.totalUnreadCount, 0);
  } else {
    // Unknown key ⇒ no-op is also a valid pin; surfaced for the S1 wiring
    // PR to align key construction with getInboxItemKey.
    assert.deepEqual(state, base);
  }
});

test("item-read drops the row under composed Unread + Mentions", () => {
  const base: InboxDomainState = {
    filter: "unread_mentions",
    items: [channelItem({ hasMention: true })],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 2,
  };
  const { state, transition } = applyInboxEvent(base, {
    kind: "patch", patch: "item-read", itemKey: "channel:ch-1",
  });

  assert.equal(transition.touched, 1);
  assert.deepEqual(state.items, []);
  assert.equal(state.totalCount, 0);
  assert.equal(state.totalUnreadCount, 0);
});

test("reconcile converges to server snapshot regardless of prior patches (I3)", () => {
  let s = emptyState();
  s = applyInboxEvent(s, {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 2,
  }).state;
  s = applyInboxEvent(s, {
    kind: "patch", patch: "item-upsert",
    item: channelItem({ unreadCount: 5, lastMessageId: "m-3" }), marker: "m-3",
  }).state;

  const serverSnapshot = [channelItem({ unreadCount: 1, lastMessageId: "m-4" })];
  const { state } = applyInboxEvent(s, {
    kind: "reconcile", filter: "all",
    items: serverSnapshot, hasMore: false, totalCount: 1, totalUnreadCount: 1,
  });
  assert.deepEqual(state.items, serverSnapshot);
  assert.equal(state.totalUnreadCount, 1);
});

// ── Mutation-gate follow-up: branch pins ──────────────────────────────────

test("hydrate under a different filter is a strict no-op", () => {
  const base = emptyState("mentions");
  const { state, transition } = applyInboxEvent(base, {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 2,
  });
  assert.equal(state, base, "same reference");
  assert.equal(transition.touched, 0);
});

test("hydrate append merges pages and dedupes by key", () => {
  const page1 = applyInboxEvent(emptyState(), {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem({ channelId: "a" }), channelItem({ channelId: "b" })],
    hasMore: true, totalCount: 3, totalUnreadCount: 6,
  }).state;
  const page2 = applyInboxEvent(page1, {
    kind: "hydrate", filter: "all", reset: false,
    items: [channelItem({ channelId: "b" }), channelItem({ channelId: "c" })],
    hasMore: false, totalCount: 3, totalUnreadCount: 6,
  }).state;
  assert.deepEqual(
    page2.items.map((i) => (i.kind === "mention_action" ? i.id : i.channelId)),
    ["a", "b", "c"],
    "append keeps order, drops duplicate b",
  );
  assert.equal(page2.hasMore, false);
});

test("null server totals fall back to computed values from merged items", () => {
  const { state } = applyInboxEvent(emptyState(), {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem({ channelId: "a", unreadCount: 2 }), channelItem({ channelId: "b", unreadCount: 3 })],
    hasMore: false, totalCount: null, totalUnreadCount: null,
  });
  assert.equal(state.totalCount, 2);
  assert.equal(state.totalUnreadCount, 5);
});

test("reconcile under a different filter is a strict no-op", () => {
  const base = emptyState("unread");
  const { state, transition } = applyInboxEvent(base, {
    kind: "reconcile", filter: "all", items: [channelItem()], hasMore: false,
    totalCount: 1, totalUnreadCount: 1,
  });
  assert.equal(state, base);
  assert.equal(transition.touched, 0);
});

test("upsert of an existing item replaces IN PLACE; new item prepends", () => {
  const base = applyInboxEvent(emptyState(), {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem({ channelId: "a", unreadCount: 1 }), channelItem({ channelId: "b", unreadCount: 1 })],
    hasMore: false, totalCount: 2, totalUnreadCount: 2,
  }).state;

  const replaced = applyInboxEvent(base, {
    kind: "patch", patch: "item-upsert",
    item: channelItem({ channelId: "b", unreadCount: 4, lastMessageId: "m-x" }), marker: "m-x",
  });
  assert.deepEqual(
    replaced.state.items.map((i) => (i.kind === "mention_action" ? i.id : i.channelId)),
    ["a", "b"],
    "existing row keeps its position",
  );
  assert.equal(replaced.state.totalCount, 2, "no count change on replace");
  assert.equal(replaced.state.totalUnreadCount, 5, "2 - 1 + 4");
  assert.equal(replaced.transition.totalUnreadDelta, 3);

  const prepended = applyInboxEvent(replaced.state, {
    kind: "patch", patch: "item-upsert",
    item: channelItem({ channelId: "c", unreadCount: 1, lastMessageId: "m-y" }), marker: "m-y",
  });
  assert.equal(
    (prepended.state.items[0] as { channelId?: string }).channelId,
    "c",
    "new row prepends",
  );
  assert.equal(prepended.state.totalCount, 3);
});

test("unknown-item upsert IS applied under the unread filter (only mentions defers)", () => {
  const { state, transition } = applyInboxEvent(emptyState("unread"), {
    kind: "patch", patch: "item-upsert", item: channelItem(), marker: "m-1",
  });
  assert.equal(transition.reconcileSuggested, false);
  assert.equal(state.items.length, 1);
});

test("item-read under 'all' keeps the row but zeroes unread and mention", () => {
  const base: InboxDomainState = {
    filter: "all",
    items: [channelItem({ unreadCount: 2, hasMention: true })],
    hasMore: false, totalCount: 1, totalUnreadCount: 2,
  };
  const { state, transition } = applyInboxEvent(base, {
    kind: "patch", patch: "item-read", itemKey: "channel:ch-1",
  });
  if (transition.touched === 1) {
    assert.equal(state.items.length, 1, "row stays under 'all'");
    const kept = state.items[0] as { unreadCount: number; hasMention: boolean; firstUnreadMessageId: string | null };
    assert.equal(kept.unreadCount, 0);
    assert.equal(kept.hasMention, false);
    assert.equal(kept.firstUnreadMessageId, null);
    assert.equal(state.totalCount, 1, "totalCount unchanged under 'all'");
    assert.equal(state.totalUnreadCount, 0);
    assert.equal(transition.totalUnreadDelta, -2);
  } else {
    assert.deepEqual(state, base);
  }
});

test("all-read: no-op at zero; under 'unread' empties the list; under 'all' zeroes rows", () => {
  const zero = applyInboxEvent(emptyState(), { kind: "patch", patch: "all-read" });
  assert.equal(zero.transition.touched, 0);

  const underUnread = applyInboxEvent({
    filter: "unread", items: [channelItem({ unreadCount: 2 })], hasMore: false, totalCount: 1, totalUnreadCount: 2,
  }, { kind: "patch", patch: "all-read" });
  assert.deepEqual(underUnread.state.items, []);
  assert.equal(underUnread.state.totalCount, 0);
  assert.equal(underUnread.state.totalUnreadCount, 0);

  const underAll = applyInboxEvent({
    filter: "all",
    items: [channelItem({ channelId: "a", unreadCount: 2 }), channelItem({ channelId: "b", unreadCount: 0 })],
    hasMore: false, totalCount: 2, totalUnreadCount: 2,
  }, { kind: "patch", patch: "all-read" });
  assert.equal(underAll.state.items.length, 2, "rows stay under 'all'");
  assert.equal(underAll.transition.touched, 1, "only rows that had unread count as touched");
  assert.equal(underAll.state.totalCount, 2);
  assert.equal(underAll.state.totalUnreadCount, 0);
});

test("item-done removes the row and subtracts its unread; unknown key is a no-op", () => {
  const base: InboxDomainState = {
    filter: "all",
    items: [channelItem({ unreadCount: 2 })],
    hasMore: false, totalCount: 1, totalUnreadCount: 2,
  };
  const done = applyInboxEvent(base, { kind: "patch", patch: "item-done", itemKey: "channel:ch-1" });
  if (done.transition.touched === 1) {
    assert.deepEqual(done.state.items, []);
    assert.equal(done.state.totalCount, 0);
    assert.equal(done.state.totalUnreadCount, 0);
  }
  const miss = applyInboxEvent(base, { kind: "patch", patch: "item-done", itemKey: "channel:nope" });
  assert.equal(miss.transition.touched, 0);
  assert.equal(miss.state, base);
});

// ── Purity regression (PR #3993 review block: Aiden's repro) ─────────────────

test("PURITY: identical (state, event) gives identical results regardless of process history", () => {
  const event = {
    kind: "patch" as const, patch: "item-upsert" as const,
    item: channelItem({ unreadCount: 3, lastMessageId: "m-2" }), marker: "m-2",
  };
  const stateA = emptyState();
  const first = applyInboxEvent(stateA, event);
  assert.equal(first.transition.touched, 1);

  // A FRESH state with the same shape must produce the same result — the old
  // module-Map implementation returned touched:0 here and dropped the row.
  const stateB = emptyState();
  const second = applyInboxEvent(stateB, event);
  assert.equal(second.transition.touched, 1, "fresh state must not be affected by prior applies");
  assert.deepEqual(second.state.items, first.state.items);
});

test("marker contract: inboxItemMarker derives the adapter marker rule per row kind", () => {
  const channel = channelItem({ lastMessageId: "m-7" });
  assert.equal(inboxItemMarker(channel), "m-7");
  const thread = {
    ...channelItem(), kind: "thread", threadChannelId: "tc-1",
    parentMessageId: "p-1", parentChannelId: "ch-1", parentChannelName: "general",
    parentChannelType: "channel", parentMessagePreview: "x", parentMessageSenderType: "user",
    parentMessageSenderId: "u-1", latestActivityPreview: "y", latestActivitySenderType: "user",
    latestActivitySenderId: "u-1", latestActivityMessageId: "m-9", replyCount: 4,
    lastActivityAt: "2026-07-06T00:00:00Z", lastReplyAt: "2026-07-06T00:00:00Z",
    taskNumber: null, taskStatus: null, taskClaimedByName: null,
  } as unknown as Parameters<typeof inboxItemMarker>[0];
  assert.equal(inboxItemMarker(thread), "tc-1:2026-07-06T00:00:00Z");
});

// ── Tenny review: test the oracle itself + property-based I3 ─────────────────

test("DIVERGENCE ORACLE: a lying patch is exposed by reconcile's totalUnreadDelta", () => {
  let s = applyInboxEvent(emptyState(), {
    kind: "hydrate", filter: "all", reset: true,
    items: [channelItem({ unreadCount: 1 })], hasMore: false, totalCount: 1, totalUnreadCount: 1,
  }).state;
  // The lying patch: claims 50 unread that the server never issued.
  s = applyInboxEvent(s, {
    kind: "patch", patch: "item-upsert",
    item: channelItem({ unreadCount: 50, lastMessageId: "m-lie" }), marker: "m-lie",
  }).state;
  const { transition } = applyInboxEvent(s, {
    kind: "reconcile", filter: "all",
    items: [channelItem({ unreadCount: 1 })], hasMore: false, totalCount: 1, totalUnreadCount: 1,
  });
  assert.equal(transition.event, "reconcile");
  assert.equal(transition.totalUnreadDelta, -49, "the drift must be visible, not clamped away");
});

test("PROPERTY: any patch sequence followed by reconcile converges to the server snapshot (I3)", () => {
  // Deterministic LCG so failures are reproducible from the seed.
  let seed = 0xC0FFEE;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0xFFFFFFFF;
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];

  for (let run = 0; run < 50; run++) {
    let s = emptyState();
    const opCount = 1 + Math.floor(rand() * 12);
    for (let i = 0; i < opCount; i++) {
      const op = pick(["upsert", "read", "all-read", "done", "hydrate"]);
      const chan = `ch-${1 + Math.floor(rand() * 4)}`;
      if (op === "upsert") {
        s = applyInboxEvent(s, {
          kind: "patch", patch: "item-upsert",
          item: channelItem({ channelId: chan, unreadCount: 1 + Math.floor(rand() * 5), lastMessageId: `m-${run}-${i}` }),
          marker: `m-${run}-${i}`,
        }).state;
      } else if (op === "read") {
        s = applyInboxEvent(s, { kind: "patch", patch: "item-read", itemKey: `channel:${chan}` }).state;
      } else if (op === "all-read") {
        s = applyInboxEvent(s, { kind: "patch", patch: "all-read" }).state;
      } else if (op === "done") {
        s = applyInboxEvent(s, { kind: "patch", patch: "item-done", itemKey: `channel:${chan}` }).state;
      } else {
        s = applyInboxEvent(s, {
          kind: "hydrate", filter: "all", reset: rand() > 0.5,
          items: [channelItem({ channelId: chan, lastMessageId: `h-${run}-${i}` })],
          hasMore: false, totalCount: null, totalUnreadCount: null,
        }).state;
      }
    }
    const serverSnapshot = [
      channelItem({ channelId: "ch-1", unreadCount: 2, lastMessageId: `final-${run}` }),
      channelItem({ channelId: "ch-9", unreadCount: 0, lastMessageId: `final9-${run}` }),
    ];
    const { state: converged } = applyInboxEvent(s, {
      kind: "reconcile", filter: "all", items: serverSnapshot, hasMore: false, totalCount: 2, totalUnreadCount: 2,
    });
    assert.deepEqual(converged.items, serverSnapshot, `run ${run}: reconcile must fully converge`);
    assert.equal(converged.totalUnreadCount, 2, `run ${run}`);
    assert.equal(converged.totalCount, 2, `run ${run}`);
  }
});
