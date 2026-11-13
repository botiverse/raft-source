/**
 * #243: a hidden page sends no realtime Activity re-read. Each one is owed;
 * showing the page pays them all with exactly one `X-Raft-Fetch-Reason:
 * visibility` read (no trigger headers), and a visible page reads as before.
 */
import assert from "node:assert/strict";

let visibility: DocumentVisibilityState = "visible";
// The page's visibility, changed as the browser does: then visibilitychange.
const page = {
  show() { visibility = "visible"; document.dispatchEvent(new window.Event("visibilitychange")); },
  hide() { visibility = "hidden"; document.dispatchEvent(new window.Event("visibilitychange")); },
};

const {
  useInboxStore,
  requestInboxBackgroundRefresh,
  cancelInboxBackgroundRefresh,
  INBOX_BACKGROUND_REFRESH_INTERVAL_MS,
} = await import("../src/store/inboxStore");
const { dropOwedReads, noteLiveSessionRecovery } = await import("../src/store/hiddenOwedReads");
const { triggerServerReset } = await import("../src/store/serverResetRegistry");
const { useServerStore } = await import("../src/store/serverStore");
const { default: api } = await import("../src/api/client");

const originalGet = api.get.bind(api);

type Seen = { reason: unknown; trigger: unknown };
let seen: Seen[] = [];

function serve() {
  api.get = (async (url: string, config?: { headers?: Record<string, string> }) => {
    if (url !== "/channels/inbox") return { data: {}, headers: {} };
    seen.push({ reason: config?.headers?.["X-Raft-Fetch-Reason"], trigger: config?.headers?.["X-Raft-Fetch-Trigger"] });
    return { headers: {}, data: { items: [], totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0, hasMore: false } };
  }) as typeof api.get;
}

function reset() {
  cancelInboxBackgroundRefresh();
  dropOwedReads();
  triggerServerReset();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  useServerStore.setState({ current: { id: "server-243" } as never, serverEpoch: 1 } as never);
  useInboxStore.setState({
    items: [], groups: [], filter: "all", channelFilterId: null, loading: false, loadingMore: false,
    hasMore: false, loaded: true, totalCount: 0, totalUnreadCount: 0, activeUnreadCount: 0,
  });
  seen = [];
}

function restore() {
  api.get = originalGet;
  vi.useRealTimers();
  reset();
}

test("hidden: realtime re-reads are owed, and showing the page sends exactly one visibility read", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    page.hide();
    requestInboxBackgroundRefresh("message_new");
    requestInboxBackgroundRefresh("thread_reply");
    requestInboxBackgroundRefresh("read_persisted");
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 4);
    assert.deepEqual(seen, [], "nothing is read while hidden");

    page.show();
    // A focus that comes with the show (recoverLiveSession) pays nothing more.
    noteLiveSessionRecovery("focus", { reconnectSocket: false, reloadLiveData: false });
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 4);
    assert.deepEqual(seen, [{ reason: "visibility", trigger: undefined }]);
  } finally { restore(); }
});

test("a trailing read whose window ends while hidden is owed, not sent", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    requestInboxBackgroundRefresh("thread_reply");
    page.hide();
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
    assert.deepEqual(seen, [{ reason: "realtime_fallback", trigger: "message_new" }], "only the read sent while visible");

    page.show();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen.slice(1), [{ reason: "visibility", trigger: undefined }]);
  } finally { restore(); }
});

test("a visible page reads as before, and nothing is owed afterwards", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(seen, [{ reason: "realtime_fallback", trigger: "message_new" }]);
    page.hide();
    page.show();
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 2);
    assert.equal(seen.length, 1, "a hide/show with nothing owed reads nothing");
  } finally { restore(); }
});

test("a trailing read set while visible, then hidden and shown before its window ends: only the visibility read", async () => {
  reset();
  serve();
  vi.useFakeTimers();
  try {
    requestInboxBackgroundRefresh("message_new");
    await vi.advanceTimersByTimeAsync(0);
    requestInboxBackgroundRefresh("thread_reply");
    page.hide();
    requestInboxBackgroundRefresh("message_new");
    page.show();
    await vi.advanceTimersByTimeAsync(INBOX_BACKGROUND_REFRESH_INTERVAL_MS * 3);
    assert.deepEqual(seen.slice(1), [{ reason: "visibility", trigger: undefined }]);
  } finally { restore(); }
});

test("a reconnect reset held with a realtime re-read owed: one read, reason visibility, in either order", async () => {
  const { heldWhileHidden } = await import("../src/store/hiddenOwedReads");
  const holdReconnect = () => heldWhileHidden("inbox_reset", () => void useInboxStore.getState().loadInbox({ reset: true, background: true, reason: "reconnect" }));
  for (const order of ["realtime first", "reconnect first"]) {
    reset();
    serve();
    vi.useFakeTimers();
    try {
      page.hide();
      if (order === "realtime first") {
        requestInboxBackgroundRefresh("message_new");
        holdReconnect();
      } else {
        holdReconnect();
        requestInboxBackgroundRefresh("message_new");
      }
      page.show();
      await vi.advanceTimersByTimeAsync(10);
      assert.deepEqual(seen, [{ reason: "visibility", trigger: undefined }], order);
      // The next hidden spell holds a reconnect reset again (nothing stuck).
      page.hide();
      holdReconnect();
      page.show();
      await vi.advanceTimersByTimeAsync(10);
      assert.deepEqual(seen.slice(1), [{ reason: "reconnect", trigger: undefined }], order);
    } finally { restore(); }
  }
});
