/**
 * task #364 S2 — accepted legacy-window / unfollowed-overlay generation teeth.
 *
 * These drive the real inboxStore request paths. A boolean `loaded && empty`
 * is not authority: both responses must belong to the same reset attempt, and
 * only the newest overlay request within that attempt may publish.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, test as nodeTest } from "node:test";

import api from "../src/api/client";
import { setActivityGateForTests } from "../src/store/activityPanel/runtime";
import { useInboxStore } from "../src/store/inboxStore";
import type { InboxItem } from "../src/store/inboxStore";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { triggerServerReset } from "../src/store/serverResetRegistry";

type TestFn = () => void | Promise<void>;
const test = (name: string, fn: TestFn) =>
  nodeTest(name, { concurrency: false }, fn);

const originalGet = api.get;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function thread(label: string): Extract<InboxItem, { kind: "thread" }> {
  return {
    kind: "thread",
    threadChannelId: `thread-${label}`,
    parentMessageId: `parent-${label}`,
    parentChannelId: "channel-1",
    parentChannelName: "General",
    parentChannelType: "channel",
    parentMessagePreview: "Parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-peer",
    latestActivityPreview: `Reply ${label}`,
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-peer",
    latestActivityMessageId: `reply-${label}`,
    latestActivitySeq: "7",
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-08-03T00:00:00.000Z",
    lastReplyAt: "2026-08-03T00:00:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    isFollowing: false,
    unfollowedAt: "2026-08-03T00:00:00.000Z",
  };
}

function mainResponse() {
  return {
    data: {
      items: [],
      groups: [],
      hasMore: false,
      totalCount: 0,
      totalUnreadCount: 0,
      activeUnreadCount: 0,
    },
  };
}

beforeEach(() => {
  setActivityGateForTests("off");
  triggerServerReset();
  useServerStore.setState({
    current: { id: "server-a", name: "A", slug: "a" } as never,
    serverEpoch: 1,
  });
  useMessageStore.getState().setCurrentUserId("user-a");
});

afterEach(() => {
  api.get = originalGet;
  triggerServerReset();
  useMessageStore.getState().setCurrentUserId(null);
});

for (const arrivalOrder of ["overlay-first", "main-first"] as const) {
  test(`parallel first-window and loaded-empty overlay publish the SAME accepted generation (${arrivalOrder})`, async () => {
    const main = deferred<ReturnType<typeof mainResponse>>();
    const overlay = deferred<{ data: { items: Array<Extract<InboxItem, { kind: "thread" }>> } }>();
    api.get = (async (url: string) => {
      if (url === "/channels/inbox") return main.promise;
      if (url === "/channels/inbox/unfollowed") return overlay.promise;
      throw new Error(`Unexpected GET ${url}`);
    }) as typeof api.get;

    const mainLoad = useInboxStore.getState().loadInbox({ reset: true });
    const overlayLoad = useInboxStore.getState().loadUnfollowed();

    if (arrivalOrder === "overlay-first") {
      // The overlay may publish its captured receipt before the main response
      // has been accepted; it still belongs to that pending reset attempt.
      overlay.resolve({ data: { items: [] } });
      await overlayLoad;
      assert.equal(useInboxStore.getState().acceptedWindowGeneration, "");
      main.resolve(mainResponse());
      await mainLoad;
    } else {
      main.resolve(mainResponse());
      await mainLoad;
      assert.equal(useInboxStore.getState().unfollowedLoaded, false);
      overlay.resolve({ data: { items: [] } });
      await overlayLoad;
    }

    const state = useInboxStore.getState();
    assert.notEqual(state.acceptedWindowGeneration, "");
    assert.equal(state.unfollowedLoaded, true);
    assert.deepEqual(state.unfollowedItems, []);
    assert.equal(
      state.unfollowedWindowGeneration,
      state.acceptedWindowGeneration,
      "arrival order must not change the exact reset-attempt pairing",
    );
  });
}

for (const scenario of [
  {
    name: "newest nonempty beats an older loaded-empty response",
    newest: [thread("new-nonempty")],
    older: [] as Array<Extract<InboxItem, { kind: "thread" }>>,
    expected: ["thread-new-nonempty"],
  },
  {
    name: "newest loaded-empty beats an older nonempty response",
    newest: [] as Array<Extract<InboxItem, { kind: "thread" }>>,
    older: [thread("old-nonempty")],
    expected: [] as string[],
  },
] as const) {
  for (const arrivalOrder of ["older-first", "newest-first"] as const) {
    test(`same reset generation: ${scenario.name} (${arrivalOrder})`, async () => {
      const main = deferred<ReturnType<typeof mainResponse>>();
      const first = deferred<{ data: { items: Array<Extract<InboxItem, { kind: "thread" }>> } }>();
      const second = deferred<{ data: { items: Array<Extract<InboxItem, { kind: "thread" }>> } }>();
      let overlayRequest = 0;
      api.get = (async (url: string) => {
        if (url === "/channels/inbox") return main.promise;
        if (url === "/channels/inbox/unfollowed") {
          overlayRequest += 1;
          return overlayRequest === 1 ? first.promise : second.promise;
        }
        throw new Error(`Unexpected GET ${url}`);
      }) as typeof api.get;

      const mainLoad = useInboxStore.getState().loadInbox({ reset: true });
      const olderLoad = useInboxStore.getState().loadUnfollowed();
      // Simulate the normal retry boundary without rotating the main window:
      // the old request remains in flight, but only the new overlay request
      // owns the `inboxUnfollowedLoadGeneration` publication slot.
      useInboxStore.setState({ unfollowedLoading: false, unfollowedLoaded: false });
      const newestLoad = useInboxStore.getState().loadUnfollowed();

      if (arrivalOrder === "older-first") {
        first.resolve({ data: { items: [...scenario.older] } });
        await olderLoad;
        assert.deepEqual(
          useInboxStore.getState().unfollowedItems,
          [],
          "a superseded response cannot publish even before the newest response arrives",
        );
        second.resolve({ data: { items: [...scenario.newest] } });
        await newestLoad;
      } else {
        second.resolve({ data: { items: [...scenario.newest] } });
        await newestLoad;
        first.resolve({ data: { items: [...scenario.older] } });
        await olderLoad;
      }
      main.resolve(mainResponse());
      await mainLoad;

      const state = useInboxStore.getState();
      assert.deepEqual(
        state.unfollowedItems.map((item) => item.threadChannelId),
        scenario.expected,
        "only the newest overlay request in the SAME window generation may publish",
      );
      assert.equal(state.unfollowedWindowGeneration, state.acceptedWindowGeneration);
    });
  }
}

test("real server reset and principal change synchronously invalidate BOTH pairing receipts", () => {
  useInboxStore.setState({
    acceptedWindowGeneration: "old-window",
    unfollowedWindowGeneration: "old-window",
    unfollowedLoaded: true,
  });

  triggerServerReset();
  assert.equal(useInboxStore.getState().acceptedWindowGeneration, "");
  assert.equal(useInboxStore.getState().unfollowedWindowGeneration, null);

  useInboxStore.setState({
    acceptedWindowGeneration: "old-principal-window",
    unfollowedWindowGeneration: "old-principal-window",
  });
  useMessageStore.getState().setCurrentUserId("user-b");
  assert.equal(useInboxStore.getState().acceptedWindowGeneration, "");
  assert.equal(useInboxStore.getState().unfollowedWindowGeneration, null);
});
