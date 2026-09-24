/**
 * task #364 S2 — the thin visible receiver consumes ONE panel bundle.
 *
 * Core and legacy fixtures deliberately disagree in every field. A splice can
 * therefore never look plausible: rows, groups, totals, pagination cursor and
 * completeness must all switch together or the assertion is precisely red.
 */
import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import api from "../src/api/client";
import {
  getActivityRuntimeLoadRequestsForTests,
  resetActivityBootstrapForTests,
} from "../src/store/activityPanel/bootstrap";
import type { ActivityPanelProjectionInput } from "../src/store/activityPanel/projection";
import {
  observeActivityBootstrap,
  resetActivityRuntimeForTests,
  setActivityGateForTests,
} from "../src/store/activityPanel/runtime";
import {
  getActivityShadowVersion,
} from "../src/store/activityShadowBridge";
import { useActivityPanelWindowBundle } from "../src/store/activityPanel/useActivityShadow";
import type { ActivityWindowBundle } from "../src/store/activityPanel/windowBundle";
import type { InboxGroupCount, InboxItem } from "../src/store/inboxStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;
const originalPost = api.post;
const originalInbox = useInboxStore.getState();
const originalServer = useServerStore.getState();
const SCOPE = {
  serverId: "server-core",
  principalId: "user-core",
  filter: "all",
  windowId: "main",
} as const;

function coreRow(label = "core") {
  return {
    rowId: `row-${label}`,
    rowVersion: "11",
    latestActivitySeq: "9007199254740993",
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 6,
    hasMention: false,
    firstUnreadMessageId: `first-${label}`,
    firstMentionMessageId: null,
    maxReadSeq: "12",
    readStateVersion: "13",
    type: "channel",
    channelId: `channel-${label}`,
    channelName: `Core ${label}`,
    channelKind: "private",
    lastMessageId: `message-${label}`,
    lastMessagePreview: `core-preview-${label}`,
    lastMessageSenderKind: "agent",
    lastMessageSenderId: `sender-${label}`,
    lastMessageSenderName: `Sender ${label}`,
  };
}

function threadCoreRow(label = "thread") {
  return {
    rowId: `row-${label}`,
    rowVersion: "11",
    latestActivitySeq: "41",
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 3,
    hasMention: false,
    firstUnreadMessageId: `reply-${label}`,
    firstMentionMessageId: null,
    maxReadSeq: "12",
    readStateVersion: "13",
    type: "thread",
    threadChannelId: `thread-${label}`,
    parentMessageId: `parent-${label}`,
    parentChannelId: "channel-parent",
    parentChannelName: "Parent",
    parentChannelKind: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderKind: "user",
    parentMessageSenderId: "sender-parent",
    latestActivityPreview: "reply",
    latestActivitySenderKind: "user",
    latestActivitySenderId: "sender-reply",
    latestActivitySenderName: "Reply Sender",
    latestActivityMessageId: `reply-${label}`,
    replyCount: 1,
    lastReplyAt: "2026-08-03T00:00:00.000Z",
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: false,
  };
}

function snapshot(requestId: string, label = "core") {
  return {
    type: "snapshot",
    requestId,
    scope: SCOPE,
    epoch: "1",
    watermark: "9007199254740995",
    activityVersion: "77",
    window: {
      rows: [coreRow(label)],
      tombstones: [],
      nextCursor: null,
      hasMore: false,
      complete: true,
      totalCount: 1,
      totalUnreadCount: 6,
    },
  };
}

function threadSnapshot(requestId: string, label = "thread") {
  return {
    ...snapshot(requestId, label),
    window: {
      ...snapshot(requestId, label).window,
      rows: [threadCoreRow(label)],
    },
  };
}

const LEGACY_ITEM: InboxItem = {
  kind: "channel",
  channelId: "channel-legacy",
  channelName: "Legacy only",
  channelType: "joint",
  lastMessageId: "message-legacy",
  latestActivitySeq: "41",
  firstUnreadMessageId: "message-legacy",
  firstMentionMessageId: null,
  lastMessageAt: "2026-07-01T00:00:00.000Z",
  lastMessagePreview: "legacy-preview",
  lastMessageSenderType: "user",
  lastMessageSenderId: "legacy-sender",
  lastMessageSenderName: "Legacy Sender",
  unreadCount: 17,
  hasMention: false,
};

const LEGACY_GROUP: InboxGroupCount = {
  channelId: "channel-legacy",
  channelName: "Legacy group",
  channelType: "joint",
  count: 40,
  lastActivityAt: "2026-07-01T00:00:00.000Z",
};

function eligibleInput(): Omit<ActivityPanelProjectionInput, "verdict"> {
  return {
    legacySnapshot: {
      generation: "accepted-window-7",
      window: {
        items: [LEGACY_ITEM],
        groups: [LEGACY_GROUP],
        totalCount: 40,
      totalUnreadCount: 17,
      hasMore: true,
      nextCursor: "legacy-cursor-1",
      complete: false,
      },
    },
    activityView: "active",
    filter: "all",
    sortDirection: "desc",
    searchQuery: "",
    channelFilterId: null,
  };
}

function serialise(bundle: ActivityWindowBundle<InboxItem, InboxGroupCount>) {
  return {
    source: bundle.source,
    reason: bundle.source === "legacy" ? bundle.reason : null,
    items: bundle.items,
    groups: bundle.groups,
    totalCount: bundle.totalCount,
    totalUnreadCount: bundle.totalUnreadCount,
    hasMore: bundle.hasMore,
    nextCursor: bundle.nextCursor,
    complete: bundle.complete,
  };
}

function Probe({ input }: { input: Omit<ActivityPanelProjectionInput, "verdict"> }) {
  const bundle = useActivityPanelWindowBundle(input);
  return <pre data-testid="bundle">{JSON.stringify(serialise(bundle))}</pre>;
}

function readBundle() {
  return JSON.parse(screen.getByTestId("bundle").textContent ?? "null") as ReturnType<typeof serialise>;
}

async function seedCore(gate: "on" | "shadow", label = "core") {
  setActivityGateForTests(gate);
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return { data: snapshot(config?.params?.requestId ?? "missing", label) };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  await observeActivityBootstrap();
}

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  useInboxStore.setState(originalInbox, true);
  useServerStore.setState(originalServer, true);
  resetActivityBootstrapForTests();
  resetActivityRuntimeForTests();
});

test("lazy module readiness alone wakes the receiver and switches EVERY field to one core bundle", async () => {
  // Seed before mount. After render there is deliberately no new watermark and
  // no legacy-store event; only the lazy module promise resolving can wake it.
  await seedCore("on", "atomic");
  resetActivityBootstrapForTests();

  render(<Probe input={eligibleInput()} />);
  assert.equal(readBundle().source, "legacy", "first paint stays whole legacy while the chunk resolves");

  await waitFor(() => assert.equal(readBundle().source, "core"));
  const bundle = readBundle();
  assert.equal(getActivityRuntimeLoadRequestsForTests(), 1, "one cached runtime load request");
  assert.deepEqual(bundle.items, [{
    kind: "channel",
    channelId: "channel-atomic",
    channelName: "Core atomic",
    channelType: "private",
    lastMessageId: "message-atomic",
    latestActivitySeq: "9007199254740993",
    firstUnreadMessageId: "first-atomic",
    firstMentionMessageId: null,
    lastMessageAt: "2026-08-03T00:00:00.000Z",
    lastMessagePreview: "core-preview-atomic",
    lastMessageSenderType: "agent",
    lastMessageSenderId: "sender-atomic",
    lastMessageSenderName: "Sender atomic",
    unreadCount: 6,
    hasMention: false,
  }]);
  assert.deepEqual(bundle.groups, [{
    channelId: "channel-atomic",
    channelName: "Core atomic",
    channelType: "private",
    count: 1,
    lastActivityAt: "2026-08-03T00:00:00.000Z",
  }]);
  assert.equal(bundle.totalCount, 1, "totalCount is core, never legacy 40");
  assert.equal(bundle.totalUnreadCount, 6, "unread count is core, never legacy 17");
  assert.equal(bundle.hasMore, false, "hasMore is core, never legacy true");
  assert.equal(bundle.nextCursor, null, "cursor is core, never legacy-cursor-1");
  assert.equal(bundle.complete, true, "completeness is core, never legacy false");
});

test("gate-on receiver drops an old in-flight Core snapshot after Done invalidation", async () => {
  // First establish the exact production path: a real runtime snapshot is
  // accepted, the bound Core row is visible through the receiver, and the
  // legacy fixture is deliberately different.
  setActivityGateForTests("on");
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      return { data: threadSnapshot(config?.params?.requestId ?? "missing", "before-done") };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  await observeActivityBootstrap();
  resetActivityBootstrapForTests();
  const visibleThread = {
    kind: "thread",
    threadChannelId: "thread-before-done",
    parentMessageId: "parent-before-done",
    parentChannelId: "channel-parent",
    parentChannelName: "Parent",
    parentChannelType: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "sender-parent",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "sender-reply",
    latestActivityMessageId: "reply-before-done",
    latestActivitySeq: "41",
    firstUnreadMessageId: "reply-before-done",
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    lastReplyAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 3,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: false,
    doneFrontierSeq: "41",
    readStateLatestActivitySeq: "41",
  } as InboxItem;
  const input = {
    ...eligibleInput(),
    legacySnapshot: {
      ...eligibleInput().legacySnapshot,
      window: { ...eligibleInput().legacySnapshot.window, items: [visibleThread] },
    },
  };
  const view = render(<Probe input={input} />);
  await waitFor(() => assert.equal(readBundle().source, "core"));
  assert.equal(readBundle().items[0]?.kind, "thread");
  assert.equal(readBundle().items[0]?.threadChannelId, "thread-before-done");

  // Issue a second, older-generation snapshot and hold its response open.
  // This models the response that can still be in flight when the user clicks
  // Done. The real Done path calls this same bridge invalidation synchronously
  // at intent, before its POST settles.
  let release!: (value: { data: unknown }) => void;
  let resolveDone!: (value: { data: { ok: boolean } }) => void;
  let staleRequestId = "";
  let snapshotCalls = 0;
  const staleResponse = new Promise<{ data: unknown }>((resolve) => { release = resolve; });
  const doneResponse = new Promise<{ data: { ok: boolean } }>((resolve) => { resolveDone = resolve; });
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      snapshotCalls += 1;
      staleRequestId = config?.params?.requestId ?? "";
      if (snapshotCalls === 1) return staleResponse;
      return { data: threadSnapshot(staleRequestId, "fresh-after-done") };
    }
    if (url === "/channels/inbox") {
      return { data: { items: [], groups: [], totalCount: 0, totalUnreadCount: 0, hasMore: false } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  const pending = observeActivityBootstrap();
  await waitFor(() => assert.notEqual(staleRequestId, "", "the stale snapshot must be in flight before Done invalidates its generation"));

  useServerStore.setState({ current: { id: SCOPE.serverId }, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items: [visibleThread],
    groups: [],
    filter: "all",
    channelFilterId: null,
    loading: false,
    loadingMore: false,
    hasMore: false,
    loaded: true,
    totalCount: 1,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
    focusedItemKey: null,
  } as never);
  let donePostUrl = "";
  api.post = ((url: string) => { donePostUrl = url; return doneResponse; }) as typeof api.post;
  const done = useInboxStore.getState().markDone(visibleThread);
  assert.equal(donePostUrl, "/channels/threads/done");
  assert.equal(getActivityShadowVersion(), null, "Done intent must clear the visible Core watermark immediately");
  await waitFor(() => assert.equal(readBundle().source, "legacy"));

  // The response body is otherwise valid and carries the exact request id;
  // only its generation is stale. It must not republish the pre-Done row.
  release({ data: threadSnapshot(staleRequestId, "stale-after-done") });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getActivityShadowVersion(), null);
  assert.equal(readBundle().source, "legacy");
  assert.equal(readBundle().items[0]?.threadChannelId, "thread-before-done");

  resolveDone({ data: { ok: true } });
  await done;

  view.unmount();
});

test("gate-on receiver drops an old in-flight channel Core snapshot after channel Done", async () => {
  await seedCore("on", "channel-before-done");
  resetActivityBootstrapForTests();
  const visibleChannel = {
    ...LEGACY_ITEM,
    channelId: "channel-channel-before-done",
    channelName: "Core channel",
    doneFrontierSeq: "41",
    readStateLatestActivitySeq: "41",
  } as InboxItem;
  const input = {
    ...eligibleInput(),
    legacySnapshot: {
      ...eligibleInput().legacySnapshot,
      window: { ...eligibleInput().legacySnapshot.window, items: [visibleChannel] },
    },
  };
  const view = render(<Probe input={input} />);
  await waitFor(() => assert.equal(readBundle().source, "core"));
  assert.equal(readBundle().items[0]?.channelId, "channel-channel-before-done");

  let release!: (value: { data: unknown }) => void;
  let staleRequestId = "";
  let snapshotCalls = 0;
  const staleResponse = new Promise<{ data: unknown }>((resolve) => { release = resolve; });
  api.get = (async (url: string, config?: { params?: { requestId?: string } }) => {
    if (url === "/channels/activity/snapshot") {
      snapshotCalls += 1;
      staleRequestId = config?.params?.requestId ?? "";
      if (snapshotCalls === 1) return staleResponse;
      return { data: snapshot(staleRequestId, "fresh-after-done") };
    }
    if (url === "/channels/inbox") {
      return { data: { items: [], groups: [], totalCount: 0, totalUnreadCount: 0, hasMore: false } };
    }
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  const pending = observeActivityBootstrap();
  await waitFor(() => assert.notEqual(staleRequestId, ""));

  useServerStore.setState({ current: { id: SCOPE.serverId }, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items: [visibleChannel], groups: [], filter: "all", channelFilterId: null,
    loading: false, loadingMore: false, hasMore: false, loaded: true,
    totalCount: 1, totalUnreadCount: 0, activeUnreadCount: 0, focusedItemKey: null,
  } as never);
  let donePostUrl = "";
  let resolveDone!: (value: { data: { ok: boolean } }) => void;
  const doneResponse = new Promise<{ data: { ok: boolean } }>((resolve) => { resolveDone = resolve; });
  api.post = ((url: string) => { donePostUrl = url; return doneResponse; }) as typeof api.post;
  const done = useInboxStore.getState().markDone(visibleChannel);
  assert.equal(donePostUrl, "/channels/inbox/done");
  assert.equal(getActivityShadowVersion(), null);
  await waitFor(() => assert.equal(readBundle().source, "legacy"));

  release({ data: snapshot(staleRequestId, "stale-after-done") });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getActivityShadowVersion(), null);
  assert.equal(readBundle().source, "legacy");
  assert.equal(readBundle().items[0]?.channelId, "channel-channel-before-done");

  resolveDone({ data: { ok: true } });
  await done;
  view.unmount();
});

test("gate OFF is byte-for-byte legacy and requests zero heavy runtime loads", async () => {
  setActivityGateForTests("off");
  resetActivityBootstrapForTests();
  const input = eligibleInput();
  render(<Probe input={input} />);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getActivityRuntimeLoadRequestsForTests(), 0);
  assert.deepEqual(readBundle(), {
    source: "legacy",
    reason: "gate_closed",
    ...input.legacySnapshot.window,
  });
});

test("gate SHADOW may fold the core sentinel but the explicit receiver fence stays byte-for-byte legacy", async () => {
  // The runtime entry intentionally exposes the ungated Core candidate to S2;
  // therefore deleting the hook's explicit `gate !== on` fence makes this test
  // reveal the core sentinel instead of accidentally passing via host fallback.
  await seedCore("shadow", "shadow-sentinel");
  resetActivityBootstrapForTests();
  const input = eligibleInput();
  render(<Probe input={input} />);

  await waitFor(() => assert.equal(getActivityRuntimeLoadRequestsForTests(), 1));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readBundle(), {
    source: "legacy",
    reason: "gate_closed",
    ...input.legacySnapshot.window,
  });
});

test("every visible facet / generation / legacy-only denial returns the ENTIRE legacy window", async () => {
  await seedCore("on", "denial-positive-control");
  resetActivityBootstrapForTests();
  const positive = eligibleInput();
  const view = render(<Probe input={positive} />);
  await waitFor(() => assert.equal(readBundle().source, "core"));

  const terminalThread: Extract<InboxItem, { kind: "thread" }> = {
    kind: "thread",
    threadChannelId: "thread-terminal",
    parentMessageId: "parent-terminal",
    parentChannelId: "channel-terminal",
    parentChannelName: "Terminal",
    parentChannelType: "channel",
    parentMessagePreview: "Parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "peer",
    latestActivityPreview: "Terminal reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "peer",
    latestActivityMessageId: "reply-terminal",
    latestActivitySeq: "88",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-08-02T00:00:00.000Z",
    lastReplyAt: "2026-08-02T00:00:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: false,
    unfollowedAt: "2026-08-02T00:00:00.000Z",
  };
  const mentionAction: InboxItem = {
    kind: "mention_action",
    id: "mention-action-1",
    channelId: "channel-legacy",
    channelName: "Legacy only",
    channelType: "joint",
    messageId: "mention-message",
    messagePreview: "Legacy action",
    createdAt: "2026-08-02T00:00:00.000Z",
    pendingMentionActions: [],
    unreadCount: 0,
    hasMention: false,
  };

  const cases: Array<{
    name: string;
    reason: string;
    input: Omit<ActivityPanelProjectionInput, "verdict">;
  }> = [
    { name: "saved view", reason: "activity_view_not_active", input: { ...eligibleInput(), activityView: "saved" } },
    { name: "unread filter", reason: "activity_filter_not_all", input: { ...eligibleInput(), filter: "unread" } },
    { name: "ascending sort", reason: "activity_sort_not_desc", input: { ...eligibleInput(), sortDirection: "asc" } },
    { name: "search", reason: "activity_search_not_empty", input: { ...eligibleInput(), searchQuery: "needle" } },
    { name: "channel filter", reason: "activity_channel_filter_active", input: { ...eligibleInput(), channelFilterId: "channel-legacy" } },
    {
      name: "missing window generation",
      reason: "activity_window_generation_missing",
      input: {
        ...eligibleInput(),
        legacySnapshot: {
          ...eligibleInput().legacySnapshot,
          generation: "",
        },
      },
    },
    {
      name: "terminal-unfollow merged row",
      reason: "activity_legacy_only_overlay_present",
      input: {
        ...eligibleInput(),
        legacySnapshot: {
          ...eligibleInput().legacySnapshot,
          window: { ...eligibleInput().legacySnapshot.window, items: [terminalThread] },
        },
      },
    },
    {
      name: "mention_action",
      reason: "activity_legacy_only_overlay_present",
      input: {
        ...eligibleInput(),
        legacySnapshot: {
          ...eligibleInput().legacySnapshot,
          window: { ...eligibleInput().legacySnapshot.window, items: [mentionAction] },
        },
      },
    },
  ];

  for (const scenario of cases) {
    view.rerender(<Probe input={scenario.input} />);
    await waitFor(() => assert.equal(readBundle().source, "legacy", scenario.name));
    const bundle = readBundle();
    assert.equal(bundle.reason, scenario.reason, `${scenario.name}: precise denial`);
    assert.deepEqual(
      {
        items: bundle.items,
        groups: bundle.groups,
        totalCount: bundle.totalCount,
        totalUnreadCount: bundle.totalUnreadCount,
        hasMore: bundle.hasMore,
        nextCursor: bundle.nextCursor,
        complete: bundle.complete,
      },
      scenario.input.legacySnapshot.window,
      `${scenario.name}: no core/legacy splice is permitted`,
    );
  }
});
