/**
 * #triage:#229: a throttled background Activity re-read names the realtime
 * event behind it (`X-Raft-Fetch-Trigger`) and how many requests were folded
 * into it (`X-Raft-Fetch-Coalesced`). Observability only: the number and
 * timing of reads is unchanged.
 */
import assert from "node:assert/strict";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });

const {
  useInboxStore,
  requestInboxBackgroundRefresh,
  cancelInboxBackgroundRefresh,
  INBOX_BACKGROUND_REFRESH_INTERVAL_MS,
} = await import("../src/store/inboxStore");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { notifyChannelReadPersistedLocally } = await import("../src/store/readStateSync");
const { getCurrentPrincipalId } = await import("../src/store/principalRuntime");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);

type Seen = { reason: unknown; trigger: unknown; coalesced: unknown };
let seen: Seen[] = [];
let hold: Promise<void> | null = null;

function serve() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    seen.push({
      reason: config?.headers?.["X-Raft-Fetch-Reason"],
      trigger: config?.headers?.["X-Raft-Fetch-Trigger"],
      coalesced: config?.headers?.["X-Raft-Fetch-Coalesced"],
    });
    if (hold) await hold;
    return {
      headers: {},
      data: { items: [], totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false },
    };
  }) as typeof api.get;
}

function reset() {
  cancelInboxBackgroundRefresh();
  triggerServerReset();
  useServerStore.setState({ current: { id: "server-229" } as never, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items: [],
    groups: [],
    filter: "all",
    channelFilterId: null,
    loading: false,
    loadingMore: false,
    hasMore: false,
    loaded: true,
    totalCount: 0,
    totalUnreadCount: 0,
    activeUnreadCount: 0,
  });
  seen = [];
  hold = null;
}

function restore() {
  api.get = originalGet;
  vi.useRealTimers();
  reset();
}

test("an immediate background re-read sends its trigger and a coalesced count of 1", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("dm_new");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen, [{ reason: "realtime_fallback", trigger: "dm_new", coalesced: "1" }]);
  } finally { restore(); }
});

test("requests inside the throttle window send one read carrying the FIRST trigger and the merged count", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    requestInboxBackgroundRefresh("thread_reply");
    requestInboxBackgroundRefresh("activity_changed");
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS - 1);
    assert.equal(seen.length, 1, "the window has not ended: no extra read");
    await vi.advanceTimersByTimeAsync(1);
    assert.deepEqual(seen, [
      { reason: "realtime_fallback", trigger: "message_new", coalesced: "1" },
      { reason: "realtime_fallback", trigger: "thread_reply", coalesced: "3" },
    ]);
    // The next window starts fresh.
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS);
    requestInboxBackgroundRefresh("catch_up_retry");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen[2], { reason: "realtime_fallback", trigger: "catch_up_retry", coalesced: "1" });
    assert.equal(seen.length, 3);
  } finally { restore(); }
});

test("a cancelled trailing read does not leak its trigger or count into the next one", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    requestInboxBackgroundRefresh("dm_new");
    requestInboxBackgroundRefresh("dm_new");
    cancelInboxBackgroundRefresh();
    requestInboxBackgroundRefresh("thread_reply");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen[1], { reason: "realtime_fallback", trigger: "thread_reply", coalesced: "1" });
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
    assert.equal(seen.length, 2);
  } finally { restore(); }
});

test("background reads folded into one in flight keep the first trigger and add up their counts", async () => {
  reset();
  serve();
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = useInboxStore.getState().loadInbox({
      reset: true, background: true, reason: "realtime_fallback", trigger: { trigger: "message_new", coalesced: 1 },
    });
    await Promise.resolve();
    const a = useInboxStore.getState().loadInbox({
      reset: true, background: true, reason: "realtime_fallback", trigger: { trigger: "thread_reply", coalesced: 2 },
    });
    // A folded reset without a trigger (not realtime) adds nothing.
    const b = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "sync_reset" });
    const c = useInboxStore.getState().loadInbox({
      reset: true, background: true, reason: "realtime_fallback", trigger: { trigger: "dm_new", coalesced: 1 },
    });
    hold = null;
    release();
    await Promise.all([first, a, b, c]);
    assert.deepEqual(seen, [
      { reason: "realtime_fallback", trigger: "message_new", coalesced: "1" },
      { reason: "realtime_fallback", trigger: "thread_reply", coalesced: "3" },
    ]);
  } finally { restore(); }
});

test("a realtime read folded first, then a sync reset: the trailing sync read carries no trigger", async () => {
  reset();
  serve();
  let release: () => void = () => undefined;
  hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    const first = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "reconnect" });
    await Promise.resolve();
    const realtime = useInboxStore.getState().loadInbox({
      reset: true, background: true, reason: "realtime_fallback", trigger: { trigger: "thread_reply", coalesced: 2 },
    });
    const sync = useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "sync_reset" });
    hold = null;
    release();
    await Promise.all([first, realtime, sync]);
    assert.deepEqual(seen, [
      { reason: "reconnect", trigger: undefined, coalesced: undefined },
      { reason: "sync_reset", trigger: undefined, coalesced: undefined },
    ]);
  } finally { restore(); }
});

test("reads not asked for by a realtime event carry no trigger headers", async () => {
  reset();
  serve();
  try {
    await useInboxStore.getState().refreshInbox();
    await useInboxStore.getState().loadInbox({ reset: true, reason: "reconnect" });
    await useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "sync_reset" });
    assert.deepEqual(seen, [
      { reason: "manual", trigger: undefined, coalesced: undefined },
      { reason: "reconnect", trigger: undefined, coalesced: undefined },
      { reason: "sync_reset", trigger: undefined, coalesced: undefined },
    ]);
  } finally { restore(); }
});

test("a persisted read while Activity is loaded asks with read_persisted", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    notifyChannelReadPersistedLocally({
      channelId: "c-1",
      serverId: "server-229",
      serverEpoch: 1,
      principalId: getCurrentPrincipalId(),
    });
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen, [{ reason: "realtime_fallback", trigger: "read_persisted", coalesced: "1" }]);
  } finally { restore(); }
});
