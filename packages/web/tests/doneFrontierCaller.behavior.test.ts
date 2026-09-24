// Gate B2: every Web Done caller must send the accepted row's explicit
// guard-domain frontier. Display pairs, IDs, timestamps, reply counts, and
// read-state projections are deliberately not substitutes for this value.
import assert from "node:assert/strict";
import test from "node:test";

import api from "../src/api/client";
import { useInboxStore, getInboxItemKey } from "../src/store/inboxStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

type Call = { url: string; body: unknown };

function captureCalls(inboxRows: unknown[] = []): Call[] {
  const calls: Call[] = [];
  api.post = (async (url: string, body: unknown) => {
    calls.push({ url, body });
    return { data: {} };
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (url === "/channels/threads/followed") return { data: { threads: [] } };
    if (url === "/channels/inbox") {
      return {
        data: {
          items: inboxRows,
          hasMore: false,
          totalCount: inboxRows.length,
          totalUnreadCount: 0,
          activeUnreadCount: 0,
        },
      };
    }
    return { data: {} };
  }) as typeof api.get;
  return calls;
}

function followedThread(threadChannelId: string, latestActivitySeq: string | null) {
  return {
    threadChannelId,
    parentMessageId: `parent-${threadChannelId}`,
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel" as const,
    parentMessagePreview: "hi",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivitySeq,
    replyCount: 7,
    lastReplyAt: "2026-07-30T00:00:00.000Z",
    unreadCount: 1,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
  };
}

function channelItem(
  channelId: string,
  latestActivitySeq: string | null,
  doneFrontierSeq: string | null = latestActivitySeq,
) {
  return {
    kind: "channel" as const,
    channelId,
    channelName: "general",
    channelType: "channel" as const,
    lastMessageId: `message-${channelId}`,
    latestActivitySeq,
    doneFrontierSeq,
    readStateLatestActivitySeq: latestActivitySeq,
    firstUnreadMessageId: `message-${channelId}`,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-30T00:00:00.000Z",
    lastMessagePreview: "hi",
    lastMessageSenderType: "user" as const,
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "peer",
    unreadCount: 2,
    hasMention: false,
  };
}

test.beforeEach(() => {
  useServerStore.setState({ current: { id: "server-b2" } as never, serverEpoch: 1 } as never);
  useThreadStore.setState({ followedThreads: [] });
  useInboxStore.setState({
    items: [],
    filter: "all",
    channelFilterId: null,
    sortDirection: "desc",
    searchQuery: "",
    totalCount: 0,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  } as never);
});

test.afterEach(() => {
  api.post = originalPost;
  api.get = originalGet;
});

test("threadStore sends the followed row's exact frontier past 2^53", async () => {
  const calls = captureCalls();
  const exact = "9007199254740993";
  useThreadStore.setState({ followedThreads: [followedThread("thread-exact", exact)] });

  await useThreadStore.getState().markThreadDone("thread-exact");

  assert.deepEqual(calls, [{
    url: "/channels/threads/done",
    body: {
      threadChannelId: "thread-exact",
      throughActivitySeq: exact,
      frontierSpace: "storage",
    },
  }]);
});

test("threadStore refuses Done when the accepted row has no canonical frontier", async () => {
  const calls = captureCalls();
  useThreadStore.setState({ followedThreads: [followedThread("thread-missing", null)] });

  await useThreadStore.getState().markThreadDone("thread-missing");

  assert.equal(calls.length, 0, "replyCount and lastReplyAt must not invent a frontier");
});

test("threadStore captures the frontier before optimistic removal", async () => {
  const calls = captureCalls();
  useThreadStore.setState({ followedThreads: [followedThread("thread-remove", "512")] });

  await useThreadStore.getState().markThreadDone("thread-remove");

  assert.equal((calls[0]!.body as { throughActivitySeq: string }).throughActivitySeq, "512");
  assert.deepEqual(useThreadStore.getState().followedThreads, []);
});

test("inboxStore thread Done uses the dedicated storage frontier", async () => {
  const calls = captureCalls();
  const item = {
    ...followedThread("thread-incident", "11429659"),
    kind: "thread" as const,
    doneFrontierSeq: "11426997",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-thread-incident",
    firstUnreadMessageId: "reply-thread-incident",
    firstMentionMessageId: null,
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    hasMention: false,
  };
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  const done = calls.find((call) => call.url === "/channels/threads/done");
  assert.deepEqual(done, {
    url: "/channels/threads/done",
    body: {
      threadChannelId: "thread-incident",
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    },
  });
});

test("inboxStore channel Done sends the accepted row's exact frontier", async () => {
  const calls = captureCalls();
  const exact = "9007199254740993";
  const item = channelItem("channel-exact", exact);
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  const done = calls.find((call) => call.url === "/channels/inbox/done");
  assert.deepEqual(done, {
    url: "/channels/inbox/done",
    body: {
      channelId: "channel-exact",
      throughActivitySeq: exact,
      frontierSpace: "storage",
    },
  });
});

test("inboxStore sends the guard-domain frontier when the incident display pair diverges", async () => {
  const calls = captureCalls();
  const item = channelItem("channel-incident", "11429659", "11426997");
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  const done = calls.find((call) => call.url === "/channels/inbox/done");
  assert.deepEqual(done, {
    url: "/channels/inbox/done",
    body: {
      channelId: "channel-incident",
      throughActivitySeq: "11426997",
      frontierSpace: "storage",
    },
  });
});

test("inboxStore refuses Done when the accepted row has no guard-domain frontier", async () => {
  const item = channelItem("channel-missing", "11429659", null);
  const calls = captureCalls([item]);
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  assert.equal(calls.filter((call) => call.url.includes("/done")).length, 0);
});

test("a refused inbox Done leaves the row and count visible", async () => {
  const item = channelItem("channel-keep", "11429659", null);
  const calls = captureCalls([item]);
  useInboxStore.setState({
    items: [item],
    totalCount: 1,
    totalUnreadCount: 2,
    activeUnreadCount: 2,
  } as never);

  await useInboxStore.getState().markDone(item);

  assert.equal(calls.filter((call) => call.url.includes("/done")).length, 0);
  assert.deepEqual(useInboxStore.getState().items.map(getInboxItemKey), ["channel:channel-keep"]);
  assert.equal(useInboxStore.getState().totalCount, 1);
});

test("a refresh-required response refreshes once and never auto-retries Done", async () => {
  const item = channelItem("channel-refresh-required", "11429659", "11426997");
  const calls = captureCalls([item]);
  const capturedGet = api.get;
  let inboxRefreshes = 0;
  api.get = (async (...args: Parameters<typeof api.get>) => {
    if (args[0] === "/channels/inbox") inboxRefreshes += 1;
    return capturedGet(...args);
  }) as typeof api.get;
  api.post = (async (url: string, body: unknown) => {
    calls.push({ url, body });
    throw Object.assign(new Error("refresh required"), { response: { status: 412 } });
  }) as typeof api.post;
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  assert.equal(
    calls.filter((call) => call.url === "/channels/inbox/done").length,
    1,
    "refresh may update the accepted frontier but must not replay the mutation",
  );
  assert.equal(inboxRefreshes, 1, "the failed optimistic removal refreshes exactly once");
  assert.deepEqual(
    useInboxStore.getState().items.map(getInboxItemKey),
    ["channel:channel-refresh-required"],
  );
});

// --- Rolling compatibility: an OLD server omits `doneFrontierSeq` entirely. ---
// The 1.9.2 web shipped without these and every Done click died silently against
// the live pre-upgrade server: no request, no error, nothing to grep. Absence of
// the field is the only rolling-deploy signal available, and it is unambiguous
// because mention_action rows return earlier and an upgraded server always sends
// it on an active row. Present-but-unusable stays fail-closed — that is an
// upgraded-server anomaly, not an old server.

function legacyChannelItem(channelId: string, latestActivitySeq: string | null) {
  const item = channelItem(channelId, latestActivitySeq) as Record<string, unknown>;
  delete item.doneFrontierSeq;
  return item;
}

test("inboxStore channel Done sends no sequence at all when the server omits the frontier", async () => {
  const calls = captureCalls();
  const item = legacyChannelItem("channel-legacy", "11429659");
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item as never);

  const done = calls.find((call) => call.url === "/channels/inbox/done");
  // No frontierSpace: an old server reads throughActivitySeq in the display
  // space it still expects. Sending the marker would be a lie about the units.
  // No throughActivitySeq at all. Offering the display pair is the #29 units
  // mismatch: on a joint row it is a local value while the old server validates
  // against its canonical latest (measured 409 DONE_FRONTIER_BEYOND_LATEST).
  // Omitting it routes the old server to its legacy snapshot path, which
  // resolves canonical latest where the authoritative value actually lives.
  assert.deepEqual(done, {
    url: "/channels/inbox/done",
    body: { channelId: "channel-legacy" },
  });
});

test("inboxStore thread Done sends no sequence at all when the server omits the frontier", async () => {
  const calls = captureCalls();
  const item = {
    ...followedThread("thread-legacy", "11429659"),
    kind: "thread" as const,
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-thread-legacy",
    firstUnreadMessageId: "reply-thread-legacy",
    firstMentionMessageId: null,
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    hasMention: false,
  };
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item as never);

  const done = calls.find((call) => call.url === "/channels/threads/done");
  assert.deepEqual(done, {
    url: "/channels/threads/done",
    body: { threadChannelId: "thread-legacy" },
  });
});

test("an explicitly null frontier is NOT treated as an old server", async () => {
  // The discriminator is absence, not falsiness. A row that carries the field
  // as null came from an upgraded server that could not produce a frontier;
  // guessing the display pair there is exactly the units mismatch #6071 fixed.
  const item = channelItem("channel-null-frontier", "11429659", null);
  const calls = captureCalls([item]);
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item);

  assert.equal(calls.filter((call) => call.url.includes("/done")).length, 0);
});

test("the legacy shape carries no sequence even when a display pair is available", async () => {
  // Negative control for the compat branch: it must never smuggle a sequence
  // back in. A row whose display pair diverges from storage (the incident
  // shape, 11429659 vs 11426997) is exactly where sending one goes wrong.
  const calls = captureCalls();
  const item = legacyChannelItem("channel-legacy-diverged", "11429659");
  useInboxStore.setState({ items: [item], totalCount: 1 } as never);

  await useInboxStore.getState().markDone(item as never);

  const done = calls.find((call) => call.url === "/channels/inbox/done");
  assert.deepEqual(done, {
    url: "/channels/inbox/done",
    body: { channelId: "channel-legacy-diverged" },
  });
  assert.equal(Object.hasOwn(done!.body as object, "throughActivitySeq"), false);
  assert.equal(Object.hasOwn(done!.body as object, "frontierSpace"), false);
});
