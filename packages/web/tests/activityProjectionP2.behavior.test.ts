/**
 * task #364 Projection P2 — groups and eligibility fail closed as one
 * whole-window decision.
 *
 * LOAD-BEARING TEETH / REVERSE CUTS:
 * - groups are aggregated from the projected CORE items; borrowing legacy
 *   groups makes the positive deep-equal red;
 * - channel/dm self identity and thread-parent identity are all distinct, so
 *   swapping a source field makes the group tooth red;
 * - count, max(lastActivityAt), DM-first, and recent ordering are each visible;
 * - every eligibility branch has a case whose other conditions are eligible;
 *   deleting that branch serves core and turns its case red;
 * - server-owned `isFollowing=false` projects through core while legacy-only
 *   terminal timestamps still fail the whole window closed;
 * - mention_action is the only changed fact in its case; treating `all` as
 *   permission for that legacy-only action turns it red;
 * - malformed generated rows and incoherent group metadata fall back WHOLE,
 *   so bypassing the canonical narrow or choosing arbitrary metadata is red.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityWindowAuthority } from "../src/store/activityPanel/windowAuthority";
import {
  buildActivityPanelWindowBundle,
  projectActivityRows,
} from "../src/store/activityPanel/projection";
import type {
  ActivityPanelProjectionInput,
} from "../src/store/activityPanel/projection";
import type {
  ActivityWindowBundle,
  ActivityWindowInputs,
} from "../src/store/activityPanel/windowBundle";
import type { InboxGroupCount, InboxItem } from "../src/store/inboxStore";

const BIG_SEQ = "9007199254740993";

function channelRow(label: string, overrides: Record<string, unknown> = {}) {
  return {
    rowId: `row-${label}`,
    rowVersion: "11",
    latestActivitySeq: BIG_SEQ,
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    unreadCount: 3,
    hasMention: false,
    firstUnreadMessageId: `first-unread-${label}`,
    firstMentionMessageId: null,
    maxReadSeq: "12",
    readStateVersion: "13",
    type: "channel",
    channelId: `channel-${label}`,
    channelName: `Channel ${label}`,
    channelKind: "private",
    lastMessageId: `last-message-${label}`,
    lastMessagePreview: `preview-${label}`,
    lastMessageSenderKind: "agent",
    lastMessageSenderId: `sender-${label}`,
    lastMessageSenderName: `Sender ${label}`,
    ...overrides,
  };
}

function threadRow(label: string, overrides: Record<string, unknown> = {}) {
  return {
    rowId: `row-${label}`,
    rowVersion: "21",
    latestActivitySeq: BIG_SEQ,
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 5,
    hasMention: false,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    maxReadSeq: "22",
    readStateVersion: "23",
    type: "thread",
    threadChannelId: `thread-channel-${label}`,
    parentMessageId: `parent-message-${label}`,
    parentChannelId: `parent-channel-${label}`,
    parentChannelName: `Parent ${label}`,
    parentChannelKind: "joint",
    parentMessagePreview: `parent-preview-${label}`,
    parentMessageSenderKind: "user",
    parentMessageSenderId: `parent-sender-${label}`,
    latestActivityPreview: `latest-preview-${label}`,
    latestActivitySenderKind: "system",
    latestActivitySenderId: `latest-sender-${label}`,
    latestActivitySenderName: `latest-sender-name-${label}`,
    latestActivityMessageId: `latest-message-${label}`,
    isFollowing: true,
    replyCount: 7,
    lastReplyAt: "2026-08-03T00:00:00.000Z",
    taskNumber: 42,
    taskStatus: "in_progress",
    taskClaimedByName: `Claimed ${label}`,
    ...overrides,
  };
}

function projectedItem(row: Record<string, unknown>): InboxItem {
  const projected = projectActivityRows([row]);
  assert.ok(projected, "test fixture must pass the production generated validator");
  assert.equal(projected.length, 1);
  return projected[0]!;
}

const LEGACY_ITEM = projectedItem(channelRow("legacy", {
  channelId: "legacy-channel",
  channelName: "Legacy only",
  lastActivityAt: "2026-07-01T00:00:00.000Z",
}));

const LEGACY_WINDOW: ActivityWindowInputs<InboxItem, InboxGroupCount> = {
  items: [LEGACY_ITEM],
  groups: [{
    channelId: "legacy-channel",
    channelName: "Legacy group",
    channelType: "private",
    count: 40,
    lastActivityAt: "2026-07-01T00:00:00.000Z",
  }],
  totalCount: 40,
  totalUnreadCount: 17,
  hasMore: true,
  nextCursor: "legacy-cursor",
  complete: false,
};

const GROUP_ROWS = [
  channelRow("alpha", {
    channelId: "channel-alpha",
    channelName: "Alpha",
    channelKind: "private",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
  }),
  threadRow("alpha-thread", {
    parentChannelId: "channel-alpha",
    parentChannelName: "Alpha",
    parentChannelKind: "private",
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    lastReplyAt: "2026-08-03T00:00:00.000Z",
  }),
  channelRow("bravo", {
    channelId: "channel-bravo",
    channelName: "Bravo",
    channelKind: "joint",
    lastActivityAt: "2026-08-04T00:00:00.000Z",
  }),
  channelRow("dm", {
    type: "dm",
    channelId: "dm-first",
    channelName: "DM first",
    channelKind: "dm",
    // Deliberately older than both non-DM groups. The existing panel sorting
    // contract still places DMs first.
    lastActivityAt: "2026-07-01T00:00:00.000Z",
  }),
];

function coreVerdict(
  rows: ReadonlyArray<Record<string, unknown>> = GROUP_ROWS,
): Extract<ActivityWindowAuthority, { authority: "core" }> {
  return {
    authority: "core",
    rows,
    nextCursor: null,
    hasMore: false,
    complete: true,
    totalCount: rows.length,
    totalUnreadCount: rows.length === 0 ? 0 : 9,
    activityVersion: "77",
  };
}

function eligibleInput(
  rows: ReadonlyArray<Record<string, unknown>> = GROUP_ROWS,
): ActivityPanelProjectionInput {
  return {
    verdict: coreVerdict(rows),
    legacySnapshot: {
      generation: "legacy-window-generation-7",
      window: LEGACY_WINDOW,
    },
    activityView: "active",
    filter: "all",
    sortDirection: "desc",
    searchQuery: "",
    channelFilterId: null,
  };
}

function assertWholeLegacy(
  bundle: ActivityWindowBundle<InboxItem, InboxGroupCount>,
  reason: string,
  label: string,
  expectedWindow: ActivityWindowInputs<InboxItem, InboxGroupCount> = LEGACY_WINDOW,
): void {
  assert.equal(bundle.source, "legacy", `${label}: must fail the WHOLE window closed`);
  assert.equal(bundle.source === "legacy" ? bundle.reason : null, reason, `${label}: exact denial reason`);
  assert.deepEqual(bundle.items, expectedWindow.items, `${label}: items must all be legacy`);
  assert.deepEqual(bundle.groups, expectedWindow.groups, `${label}: groups must all be legacy`);
  assert.equal(bundle.totalCount, expectedWindow.totalCount, `${label}: totals must all be legacy`);
  assert.equal(bundle.totalUnreadCount, expectedWindow.totalUnreadCount, `${label}: unread total must be legacy`);
  assert.equal(bundle.hasMore, expectedWindow.hasMore, `${label}: pagination state must be legacy`);
  assert.equal(bundle.nextCursor, expectedWindow.nextCursor, `${label}: cursor must be legacy`);
  assert.equal(bundle.complete, expectedWindow.complete, `${label}: completeness must be legacy`);
}

test("P2 aggregates groups from the SAME core rows: DM-first, count, max timestamp, and recent order", () => {
  const bundle = buildActivityPanelWindowBundle(eligibleInput());

  assert.equal(bundle.source, "core", "positive control: the eligibility gate must be reachable");
  assert.equal(bundle.items.length, 4);
  assert.equal(bundle.totalCount, 4);
  assert.equal(bundle.totalUnreadCount, 9);
  assert.deepEqual(bundle.groups, [
    {
      channelId: "dm-first",
      channelName: "DM first",
      channelType: "dm",
      count: 1,
      lastActivityAt: "2026-07-01T00:00:00.000Z",
    },
    {
      channelId: "channel-bravo",
      channelName: "Bravo",
      channelType: "joint",
      count: 1,
      lastActivityAt: "2026-08-04T00:00:00.000Z",
    },
    {
      channelId: "channel-alpha",
      channelName: "Alpha",
      channelType: "private",
      count: 2,
      // max(channel activity, thread activity), not the first row's time.
      lastActivityAt: "2026-08-03T00:00:00.000Z",
    },
  ]);
  assert.notDeepEqual(bundle.groups, LEGACY_WINDOW.groups, "core groups must never be borrowed from legacy");
});

test("every unsupported facet fails closed independently while an eligible neighbour still reaches core", () => {
  assert.equal(buildActivityPanelWindowBundle(eligibleInput()).source, "core");

  const cases: Array<{
    label: string;
    reason: string;
    mutate: (input: ActivityPanelProjectionInput) => void;
  }> = [
    { label: "saved view", reason: "activity_view_not_active", mutate: (i) => { i.activityView = "saved"; } },
    { label: "done view", reason: "activity_view_not_active", mutate: (i) => { i.activityView = "done"; } },
    { label: "unread filter", reason: "activity_filter_not_all", mutate: (i) => { i.filter = "unread"; } },
    { label: "mentions filter", reason: "activity_filter_not_all", mutate: (i) => { i.filter = "mentions"; } },
    { label: "unread mentions filter", reason: "activity_filter_not_all", mutate: (i) => { i.filter = "unread_mentions"; } },
    { label: "ascending sort", reason: "activity_sort_not_desc", mutate: (i) => { i.sortDirection = "asc"; } },
    { label: "search", reason: "activity_search_not_empty", mutate: (i) => { i.searchQuery = "needle"; } },
    { label: "whitespace search", reason: "activity_search_not_empty", mutate: (i) => { i.searchQuery = " "; } },
    { label: "channel filter", reason: "activity_channel_filter_active", mutate: (i) => { i.channelFilterId = "channel-alpha"; } },
  ];

  for (const c of cases) {
    const input = eligibleInput();
    c.mutate(input);
    assertWholeLegacy(buildActivityPanelWindowBundle(input), c.reason, c.label);
  }
});

test("a missing accepted-window generation cannot authorise core", () => {
  const missingGeneration = eligibleInput();
  missingGeneration.legacySnapshot = { ...missingGeneration.legacySnapshot, generation: "" };
  assertWholeLegacy(
    buildActivityPanelWindowBundle(missingGeneration),
    "activity_window_generation_missing",
    "placeholder generation",
  );

});

test("server follow state projects through core while legacy terminal timestamps fail closed", () => {
  const projected = projectedItem(threadRow("unfollowed", { isFollowing: false }));
  assert.equal(projected.kind, "thread");
  if (projected.kind !== "thread") throw new Error("fixture must be a thread");
  assert.equal(projected.isFollowing, false);

  const core = buildActivityPanelWindowBundle(eligibleInput([
    threadRow("unfollowed", { isFollowing: false }),
  ]));
  assert.equal(core.source, "core");
  assert.equal(core.items[0]?.kind, "thread");
  assert.equal(core.items[0]?.kind === "thread" ? core.items[0].isFollowing : null, false);

  const mergedOnly = eligibleInput();
  mergedOnly.legacySnapshot = {
    ...mergedOnly.legacySnapshot,
    window: {
      ...mergedOnly.legacySnapshot.window,
      items: [{ ...projected, isFollowing: false, unfollowedAt: null }],
    },
  };
  assert.equal(buildActivityPanelWindowBundle(mergedOnly).source, "core");

  const timestampOnly = eligibleInput();
  timestampOnly.legacySnapshot = {
    ...timestampOnly.legacySnapshot,
    window: {
      ...timestampOnly.legacySnapshot.window,
      items: [{ ...projected, isFollowing: true, unfollowedAt: "2026-08-05T00:00:00.000Z" }],
    },
  };
  assertWholeLegacy(
    buildActivityPanelWindowBundle(timestampOnly),
    "activity_legacy_only_overlay_present",
    "unfollowedAt merged into legacy items",
    timestampOnly.legacySnapshot.window,
  );
});

test("mention_action is explicitly legacy-only even when every other eligibility condition passes", () => {
  const mentionAction: InboxItem = {
    kind: "mention_action",
    id: "mention-action-1",
    channelId: "channel-alpha",
    channelName: "Alpha",
    channelType: "private",
    messageId: "mention-message-1",
    messagePreview: "pending mention action",
    createdAt: "2026-08-06T00:00:00.000Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
  };
  const input = eligibleInput();
  input.legacySnapshot = {
    ...input.legacySnapshot,
    window: {
      ...input.legacySnapshot.window,
      items: [...input.legacySnapshot.window.items, mentionAction],
    },
  };

  assertWholeLegacy(
    buildActivityPanelWindowBundle(input),
    "activity_legacy_only_overlay_present",
    "mention_action allowlist fence",
    input.legacySnapshot.window,
  );

  const futureInput = eligibleInput();
  futureInput.legacySnapshot = {
    ...futureInput.legacySnapshot,
    window: {
      ...futureInput.legacySnapshot.window,
      // Simulate a future legacy union arm before this projection explicitly
      // earns a mapping for it. The runtime allowlist must fail it closed even
      // though today's static InboxItem union cannot name it yet.
      items: [{ kind: "future_action" } as unknown as InboxItem],
    },
  };
  assertWholeLegacy(
    buildActivityPanelWindowBundle(futureInput),
    "activity_legacy_only_overlay_present",
    "future non-allowlisted kind",
    futureInput.legacySnapshot.window,
  );
});

test("malformed core rows and incoherent same-channel metadata fall back whole", () => {
  const { channelName: _missing, ...malformed } = channelRow("malformed");
  const malformedInput = eligibleInput([malformed]);
  assertWholeLegacy(
    buildActivityPanelWindowBundle(malformedInput),
    "core_projection_unavailable",
    "generated-schema rejection",
  );

  const incoherentCases = [
    {
      label: "same-channel name disagreement",
      threadOverrides: { parentChannelName: "Different name", parentChannelKind: "private" },
    },
    {
      label: "same-channel type disagreement",
      threadOverrides: { parentChannelName: "Original name", parentChannelKind: "joint" },
    },
  ];
  for (const c of incoherentCases) {
    const incoherentInput = eligibleInput([
      channelRow("coherent-a", {
        channelId: "same-channel",
        channelName: "Original name",
        channelKind: "private",
      }),
      threadRow("coherent-b", {
        parentChannelId: "same-channel",
        ...c.threadOverrides,
      }),
    ]);
    assertWholeLegacy(
      buildActivityPanelWindowBundle(incoherentInput),
      "core_projection_unavailable",
      c.label,
    );
  }
});

test("an eligible empty core window remains reachable and produces empty groups", () => {
  const bundle = buildActivityPanelWindowBundle(eligibleInput([]));
  assert.equal(bundle.source, "core");
  assert.deepEqual(bundle.items, []);
  assert.deepEqual(bundle.groups, []);
  assert.equal(bundle.totalCount, 0);
});
