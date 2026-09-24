/**
 * #5690 — completed Activity rows return and the unread count jumps back.
 *
 * The defect: the optimistic local Done suppression was used as a substitute
 * for row removal and was never reconciled against server-authoritative done.
 * It was a 30s timed hide, so when the timer lapsed the next fetch re-added the
 * row (and the count followed it back up).
 *
 * The frozen contract (@赵梓淇, #proj-sync-core):
 *  1. suppression binds to the EXACT marker at click time; anything newer is
 *     visible immediately — a Done must never hide activity it did not cover;
 *  2. on server-confirmed done, reconcile from an authoritative refresh and
 *     retire the suppression, rather than letting a TTL expire;
 *  3. failure rolls back;
 *  4. a stale response may not disturb a newer round.
 *
 * These assert observable store state (items / totalCount / totalUnreadCount),
 * not the arithmetic — the total-count expression carries a `Stryker disable
 * all`, so mutation testing yields no signal there and only external
 * result-set/count consistency is meaningful.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { InboxItem } from "../src/store/inboxStore.js";
import type { FollowedThread } from "../src/store/threadStore.js";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const { useInboxStore, getInboxItemKey } = await import("../src/store/inboxStore.js");
const { triggerServerReset } = await import("../src/store/serverResetRegistry.js");
const {
  captureActivityShadowGeneration,
  getActivityShadowVersion,
  publishActivityShadowVersion,
} = await import("../src/store/activityShadowBridge.js");
const { useServerStore } = await import("../src/store/serverStore.js");
const { default: api } = await import("../src/api/client.js");

const originalPost = api.post.bind(api);
const originalGet = api.get.bind(api);

type ThreadItem = Extract<InboxItem, { kind: "thread" }>;

/** S1 = the click-time marker; S2 = strictly newer external activity. */
const S1 = "100";
const S2 = "101";

function makeThreadItem(overrides: Partial<ThreadItem> = {}): ThreadItem {
  const base = {
    kind: "thread",
    threadChannelId: "thread-5690",
    parentMessageId: "parent-1",
    parentChannelId: "channel-1",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentMessagePreview: "parent",
    parentMessageSenderType: "user",
    parentMessageSenderId: "user-1",
    latestActivityPreview: "reply",
    latestActivitySenderType: "user",
    latestActivitySenderId: "user-2",
    latestActivityMessageId: "reply-1",
    latestActivitySeq: S1,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    replyCount: 1,
    lastActivityAt: "2026-07-30T00:00:00.000Z",
    lastReplyAt: "2026-07-30T00:00:00.000Z",
    unreadCount: 0,
    hasMention: false,
    taskNumber: null,
    taskStatus: null,
    taskClaimedByName: null,
    ...overrides,
  };
  return {
    ...base,
    doneFrontierSeq: overrides.doneFrontierSeq === undefined
      ? base.latestActivitySeq
      : overrides.doneFrontierSeq,
    // In production loadInbox normalises this from the adapter outcome. These
    // fixtures build store items directly, so mirror the row's own seq — a test
    // that bumps latestActivitySeq to model new activity gets the matching
    // authority frontier, exactly as the server would send it.
    readStateLatestActivitySeq: base.latestActivitySeq,
  } as ThreadItem;
}

type ChannelItem = Extract<InboxItem, { kind: "channel" | "dm" }>;

function makeChannelItem(overrides: Partial<ChannelItem> = {}): ChannelItem {
  const base = {
    kind: "channel",
    channelId: "channel-5690",
    channelName: "general",
    channelType: "channel",
    lastMessageId: "message-1",
    latestActivitySeq: S1,
    firstUnreadMessageId: null,
    firstMentionMessageId: null,
    lastMessageAt: "2026-07-30T00:00:00.000Z",
    lastMessagePreview: "hello",
    lastMessageSenderType: "user",
    lastMessageSenderId: "user-2",
    lastMessageSenderName: "alice",
    unreadCount: 0,
    hasMention: false,
    ...overrides,
  };
  return {
    ...base,
    doneFrontierSeq: overrides.doneFrontierSeq === undefined
      ? base.latestActivitySeq
      : overrides.doneFrontierSeq,
    readStateLatestActivitySeq: base.latestActivitySeq,
  } as ChannelItem;
}

function resetInbox(items: InboxItem[] = []) {
  triggerServerReset();
  // loadInbox is server-scoped: a real load always has a current server, and
  // #632 C1 folds the authority union under THAT identity. Without it the
  // adapter correctly reports "no identity" and yields no marker.
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items,
    groups: [],
    filter: "all",
    channelFilterId: null,
    loading: false,
    loadingMore: false,
    hasMore: false,
    loaded: true,
    totalCount: items.length,
    totalUnreadCount: items.reduce((sum, i) => sum + i.unreadCount, 0),
    activeUnreadCount: items.reduce((sum, i) => sum + i.unreadCount, 0),
    scrollTop: 0,
    focusedItemKey: null,
  });
}

function restoreApi() { api.post = originalPost; api.get = originalGet; }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flushPromises() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/** Serve a fixed payload from the Activity list endpoint. */
function serveItems(items: InboxItem[]) {
  api.get = (async () => ({
    data: {
      // A real server payload carries the readState union; loadInbox folds it
      // through the adapter and normalises the frontier onto each row. Serving
      // rows without it would model an exit that does not emit the union.
      items: items.map((item) => ({
        ...item,
        readState: {
          kind: "present",
          readStateVersion: 1,
          maxReadSeq: "0",
          latestActivity: (item as { readStateLatestActivitySeq?: string | null }).readStateLatestActivitySeq
            ? { messageId: "m", seq: (item as { readStateLatestActivitySeq?: string }).readStateLatestActivitySeq }
            : null,
        },
      })),
      totalCount: items.length,
      totalUnreadCount: items.reduce((sum, i) => sum + i.unreadCount, 0),
      hasMore: false,
    },
  })) as typeof api.get;
}

function visibleKeys(): string[] {
  return useInboxStore.getState().items.map((i) => getInboxItemKey(i));
}

test("#5690 T1: activity newer than the click-time marker stays visible during AND after the pending Done", async () => {
  const atS1 = makeThreadItem();
  const atS2 = makeThreadItem({ latestActivitySeq: S2, latestActivityMessageId: "reply-2", unreadCount: 1 });
  const key = getInboxItemKey(atS1);
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  serveItems([atS2]);

  try {
    resetInbox([atS1]);
    const shadowGeneration = captureActivityShadowGeneration();
    assert.equal(publishActivityShadowVersion(shadowGeneration, "77"), true);
    void useInboxStore.getState().markDone(atS1);
    await flushPromises();

    // Optimistic removal happened, but S2 is newer than the suppressed marker.
    assert.equal(getActivityShadowVersion(), null, "click-time Done must invalidate the old Core snapshot");
    await useInboxStore.getState().refreshInbox();
    await flushPromises();
    assert.deepEqual(visibleKeys(), [key], "S2 must be visible while the Done is still pending");

    persisted.resolve({ data: { ok: true } });
    await flushPromises();
    assert.deepEqual(visibleKeys(), [key], "S2 must remain visible after the Done is confirmed");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("#5690 T2: a stale payload still carrying the click-time marker does not flow back after a confirmed Done", async () => {
  const atS1 = makeThreadItem();
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  // The server replays the SAME marker the user acted on — no new activity.
  serveItems([atS1]);

  try {
    resetInbox([atS1]);
    void useInboxStore.getState().markDone(atS1);
    await flushPromises();

    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    assert.deepEqual(visibleKeys(), [], "same-marker payload must not resurrect the completed row");
    assert.equal(useInboxStore.getState().totalCount, 0);
    assert.equal(useInboxStore.getState().totalUnreadCount, 0);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("#5690 T3: a failed Done restores the row and its counts", async () => {
  const atS1 = makeThreadItem({ unreadCount: 2 });
  const key = getInboxItemKey(atS1);
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  serveItems([atS1]);

  try {
    resetInbox([atS1]);
    void useInboxStore.getState().markDone(atS1);
    await flushPromises();
    assert.deepEqual(visibleKeys(), [], "row is optimistically hidden while in flight");

    persisted.reject(new Error("boom"));
    await flushPromises();

    assert.deepEqual(visibleKeys(), [key], "a failed Done must restore the row");
    assert.equal(useInboxStore.getState().totalUnreadCount, 2);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("#5690 T4: a late response from a superseded Done cannot disturb the newer round", async () => {
  const atS1 = makeThreadItem();
  const atS2 = makeThreadItem({ latestActivitySeq: S2, latestActivityMessageId: "reply-2" });
  const key = getInboxItemKey(atS2);
  const first = deferred<{ data: { ok: boolean } }>();
  const second = deferred<{ data: { ok: boolean } }>();
  let call = 0;
  api.post = (() => (call++ === 0 ? first.promise : second.promise)) as typeof api.post;
  serveItems([atS2]);

  try {
    resetInbox([atS1]);
    void useInboxStore.getState().markDone(atS1);   // round 1, at S1
    await flushPromises();

    // New activity makes S2 visible and, critically, establishes it as the
    // currently accepted row. Gate B2 refuses a Done object that is absent
    // from the store, so the old fixture's direct markDone(atS2) call no longer
    // represented a real second round and could not supersede generation 1.
    await useInboxStore.getState().refreshInbox();
    await flushPromises();
    assert.deepEqual(visibleKeys(), [key], "the newer S2 row must be accepted before round 2");

    void useInboxStore.getState().markDone(atS2);   // round 2, at S2 — supersedes
    await flushPromises();
    assert.deepEqual(visibleKeys(), [], "round 2 optimistically removes the accepted S2 row");

    // Round 1 lands late. It must not retire round 2's suppression.
    first.resolve({ data: { ok: true } });
    await flushPromises();

    assert.deepEqual(visibleKeys(), [], "the superseded round must not resurrect the row");

    second.resolve({ data: { ok: true } });
    await flushPromises();
    assert.deepEqual(visibleKeys(), [], "the newest round still reconciles to removed");
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("#5690 T6 (symptom): a late pre-done response cannot restore the row once the TTL lapses", async () => {
  // The reported symptom is a RACE, not a plain timer: a refresh issued BEFORE
  // the Done (payload A, still carrying S1) is already in flight when the user
  // completes the row. The old code had no superseding request, so once the 30s
  // mask expired, A's stale row and counts came back. The fix issues an
  // authoritative refresh B on success, which supersedes A.
  // NOTE: this uses a CHANNEL row deliberately. Thread rows are already shielded
  // from a stale payload by preserveNewerThreadActivity + the thread activity
  // high-water; channel/DM rows have no equivalent guard, so this is where the
  // late-A resurrection is actually observable.
  const atS1 = makeChannelItem({ unreadCount: 3 });
  const preDone = deferred<{ data: unknown }>();
  const persisted = deferred<{ data: { ok: boolean } }>();
  const realNow = Date.now;
  let getCall = 0;

  api.post = (() => persisted.promise) as typeof api.post;
  api.get = ((..._args: unknown[]) => {
    getCall += 1;
    // Call 1 = the pre-done refresh A (held). Call 2+ = authoritative B.
    if (getCall === 1) return preDone.promise;
    return Promise.resolve({
      data: { items: [], totalCount: 0, totalUnreadCount: 0, hasMore: false },
    });
  }) as typeof api.get;

  try {
    resetInbox([atS1]);

    // 1) refresh A is in flight, and its payload still contains S1.
    void useInboxStore.getState().refreshInbox();
    await flushPromises();

    // 2) user completes the row; POST succeeds -> authoritative refresh B.
    void useInboxStore.getState().markDone(atS1);
    await flushPromises();
    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    // 3) the local mask expires.
    Date.now = () => realNow() + 60_000;

    // 4) the stale pre-done response finally lands.
    preDone.resolve({
      data: { items: [atS1], totalCount: 1, totalUnreadCount: 3, hasMore: false },
    });
    await flushPromises();

    assert.deepEqual(visibleKeys(), [], "a superseded pre-done payload must not restore the row after the TTL");
    assert.equal(useInboxStore.getState().totalCount, 0, "totalCount must not regress to the stale payload");
    assert.equal(useInboxStore.getState().totalUnreadCount, 0, "totalUnreadCount must not regress to the stale payload");
  } finally {
    Date.now = realNow;
    restoreApi();
    resetInbox();
  }
});

test("#5690 T7 (boundary): if the authoritative refresh itself still serves the row, the client must not fake permanent removal", async () => {
  // Guards against a fake-"authoritative" green: this fix reconciles to the
  // server, it does not suppress forever. If the server keeps serving a
  // completed row, that is a server/read-pipeline fault and must stay visible
  // rather than being silently swallowed client-side.
  const atS1 = makeThreadItem({ unreadCount: 2 });
  const key = getInboxItemKey(atS1);
  const persisted = deferred<{ data: { ok: boolean } }>();
  const realNow = Date.now;
  api.post = (() => persisted.promise) as typeof api.post;
  serveItems([atS1]); // server never stops serving it

  try {
    resetInbox([atS1]);
    void useInboxStore.getState().markDone(atS1);
    await flushPromises();
    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    Date.now = () => realNow() + 60_000;
    await useInboxStore.getState().refreshInbox();
    await flushPromises();

    assert.deepEqual(visibleKeys(), [key], "a server that keeps serving a done row must remain observable, not masked");
  } finally {
    Date.now = realNow;
    restoreApi();
    resetInbox();
  }
});

test("#5690 T5: after a confirmed Done, items and both counts agree with the authoritative refresh", async () => {
  const done = makeThreadItem({ threadChannelId: "thread-done", unreadCount: 3 });
  const survivor = makeThreadItem({
    threadChannelId: "thread-survivor",
    latestActivityMessageId: "other-1",
    unreadCount: 4,
  });
  const persisted = deferred<{ data: { ok: boolean } }>();
  api.post = (() => persisted.promise) as typeof api.post;
  // Authoritative view after the done: only the survivor remains.
  serveItems([survivor]);

  try {
    resetInbox([done, survivor]);
    void useInboxStore.getState().markDone(done);
    await flushPromises();
    persisted.resolve({ data: { ok: true } });
    await flushPromises();

    const state = useInboxStore.getState();
    assert.deepEqual(visibleKeys(), [getInboxItemKey(survivor)]);
    assert.equal(state.totalCount, 1, "totalCount must equal the authoritative result set");
    assert.equal(state.totalUnreadCount, 4, "totalUnreadCount must equal the authoritative result set");
  } finally {
    restoreApi();
    resetInbox();
  }
});

/* ------------------------------------------------------------------------- *
 * Single-canonical-refresh teeth (@赵梓淇 call-chain ruling, option (b)).
 *
 * A thread Done used to fire TWO /channels/inbox GETs: markDone's own awaited,
 * generation-fenced refresh, plus an unawaited background refresh triggered by
 * clearThreadUnread's read-all persisted notification. Only the former can own
 * the "refresh while suppression is armed → retire" boundary, so markDone scopes
 * the notification out. Read-all persistence and the local unread clear are
 * untouched, and the default notify behaviour for every other caller stands.
 * ------------------------------------------------------------------------- */

/** Count /channels/inbox GETs while driving a thread Done to completion. */
async function inboxGetsDuringThreadDone(opts: { readAllFails?: boolean; readAllFirst?: boolean } = {}) {
  const item = makeThreadItem({ threadChannelId: "thread-single-refresh" });
  const urls: string[] = [];
  const readAll = deferred<{ data: unknown }>();
  const donePost = deferred<{ data: unknown }>();

  api.post = ((url: string) => (url.includes("read-all") ? readAll.promise : donePost.promise)) as typeof api.post;
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: { items: [], totalCount: 0, totalUnreadCount: 0, hasMore: false } };
  }) as typeof api.get;

  resetInbox([item]);
  const done = useInboxStore.getState().markDone(item);
  await flushPromises();

  const settleReadAll = () =>
    opts.readAllFails ? readAll.reject(new Error("read-all failed")) : readAll.resolve({ data: {} });

  if (opts.readAllFirst) {
    settleReadAll();
    await flushPromises();
    donePost.resolve({ data: {} });
  } else {
    donePost.resolve({ data: {} });
    await flushPromises();
    settleReadAll();
  }
  await done;
  await flushPromises();
  return urls.filter((u) => u === "/channels/inbox").length;
}

test("#5690 T8: a thread Done issues exactly one canonical /channels/inbox refresh", async () => {
  try {
    assert.equal(await inboxGetsDuringThreadDone(), 1, "markDone must own the single canonical refresh");
  } finally { restoreApi(); resetInbox(); }
});

test("#5690 T9: the single refresh holds whichever of read-all / done settles first", async () => {
  try {
    assert.equal(await inboxGetsDuringThreadDone({ readAllFirst: true }), 1, "read-all landing first must not add a refresh");
    assert.equal(await inboxGetsDuringThreadDone({ readAllFirst: false }), 1, "read-all landing last must not add a refresh");
  } finally { restoreApi(); resetInbox(); }
});

test("#5690 T10: a failed read-all cannot produce a second refresh", async () => {
  try {
    assert.equal(await inboxGetsDuringThreadDone({ readAllFails: true }), 1, "read-all failure must not add a refresh");
  } finally { restoreApi(); resetInbox(); }
});

test("#5690 T11: an ordinary clearThreadUnread still notifies and drives the canonical refresh", async () => {
  // The scoping is markDone-only: every other caller (ThreadPanel, markRead,
  // deep-link) keeps the persisted notification that Activity reconciles on.
  const { useThreadStore } = await import("../src/store/threadStore.js");
  const urls: string[] = [];
  const readAll = deferred<{ data: unknown }>();
  api.post = (() => readAll.promise) as typeof api.post;
  api.get = (async (url: string) => {
    urls.push(url);
    return { data: { items: [], totalCount: 0, totalUnreadCount: 0, hasMore: false } };
  }) as typeof api.get;

  try {
    resetInbox([]);
    useInboxStore.setState({ loaded: true });
    useThreadStore.getState().clearThreadUnread("thread-default-notify", null);
    readAll.resolve({ data: {} });
    await flushPromises();
    assert.ok(
      urls.filter((u) => u === "/channels/inbox").length >= 1,
      "the default (unscoped) caller must still trigger the canonical refresh after persist",
    );
  } finally { restoreApi(); resetInbox(); }
});

test("a confirmed Done invalidates the pre-mutation Activity Core snapshot", async () => {
  const item = makeThreadItem({
    threadChannelId: "thread-shadow-done",
    isFollowing: false,
  });
  api.post = (async () => ({ data: { ok: true } })) as typeof api.post;
  serveItems([]);

  try {
    resetInbox([item]);
    const generation = captureActivityShadowGeneration();
    assert.equal(publishActivityShadowVersion(generation, "77"), true);
    assert.equal(getActivityShadowVersion(), "77");

    await useInboxStore.getState().markDone(item);

    assert.equal(
      getActivityShadowVersion(),
      null,
      "the Core snapshot accepted before Done must not remain eligible after the mutation commits",
    );
    assert.deepEqual(visibleKeys(), []);
  } finally {
    restoreApi();
    resetInbox();
  }
});

test("#5690 T12: a superseded server's Done ack performs NO side effect against the new server", async () => {
  // Counting only inbox GETs is not sufficient: the generation fence sat AFTER
  // clearThreadUnread, so a late ack still cleared unread and POSTed /read-all
  // against the newly-selected server while the GET alone stayed blocked.
  // Every success side effect must be fail-closed, so assert on all of them.
  const item = makeThreadItem({ threadChannelId: "thread-old-server" });
  const donePost = deferred<{ data: unknown }>();
  const afterReset: string[] = [];
  let resetHappened = false;

  api.post = ((url: string) => {
    if (resetHappened) afterReset.push(`POST ${url}`);
    return donePost.promise;
  }) as typeof api.post;
  api.get = (async (url: string) => {
    if (resetHappened) afterReset.push(`GET ${url}`);
    return { data: { items: [], totalCount: 0, totalUnreadCount: 0, hasMore: false } };
  }) as typeof api.get;

  try {
    const { useThreadStore } = await import("../src/store/threadStore.js");
    resetInbox([item]);

    void useInboxStore.getState().markDone(item);
    await flushPromises();

    triggerServerReset();           // user switches server mid-flight
    resetHappened = true;

    // Seed the NEW server's state AFTER the reset, on the fields
    // clearThreadUnreadLocally actually mutates (followedThreads[].unreadCount
    // and summaries) — seeding before the reset, or on a field that does not
    // exist, proves nothing about the new server.
    const newServerThread: FollowedThread = {
      threadChannelId: "thread-old-server",
      parentMessageId: "new-parent",
      parentChannelId: "new-channel",
      parentChannelName: "new",
      parentChannelType: "channel",
      parentMessagePreview: "new server thread",
      parentMessageSenderType: "user",
      parentMessageSenderId: "user-new",
      replyCount: 2,
      lastReplyAt: "2026-07-30T00:00:00.000Z",
      unreadCount: 3,
      taskNumber: null,
      taskStatus: null,
      taskClaimedByName: null,
    };
    useThreadStore.setState({ followedThreads: [newServerThread] });
    const seededList = useThreadStore.getState().followedThreads;

    donePost.resolve({ data: {} }); // the old server's ack lands late
    await flushPromises();

    // Both consequences are collected before asserting: `assert` short-circuits,
    // so checking them one after another would let the second go unproven
    // whenever the first fires. Each must be independently demonstrable.
    const leaked = {
      requests: afterReset,
      listRecreated: useThreadStore.getState().followedThreads !== seededList,
      unreadCleared: useThreadStore.getState().followedThreads[0]?.unreadCount !== 3,
    };
    assert.deepEqual(
      leaked,
      { requests: [], listRecreated: false, unreadCleared: false },
      "a superseded server's Done ack must perform NO request against the new server and must not "
        + "touch its followed-thread state (no /read-all, no inbox refresh, no unread clear)",
    );
  } finally { restoreApi(); resetInbox(); }
});
