import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";

// #triage:#244 (re-review, finding 1): a conversation the person is not viewing
// keeps its loaded messages across a socket drop. When the reconnect's
// sync:resume is cut short (hasMore: more than the server's page limit), only
// the scopes on screen are re-read, so that list keeps a hole; a live message
// landing after it made the list look complete and its projection lowered the
// Activity row (served 53, shown 1) on every re-read.

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
}
const storage = new MemoryStorage();
const locationShim = { pathname: "/", hash: "" };
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "location", { value: locationShim, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: storage, sessionStorage: storage, location: locationShim,
    setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  },
  configurable: true,
});

const api = (await import("../src/api/client")).default;
const { useMessageStore } = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { buildMainLayoutSocketBindings } = await import("../src/store/socketBridge");
const { consumeReadStateUpdate, getAcceptedReadStateProjection, resetReadStateSyncForTests } = await import("../src/store/readStateSync");
const { projectInboxItem } = await import("../src/store/inboxReadProjection");
const { __resetResumeWindowContinuityForTests } = await import("../src/store/resumeWindowContinuity");

const SERVER = "server-resume-hole";
const VIEWER = "viewer-1";
const C = "channel-c";
const OPEN = "channel-open";
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

const msg = (channelId: string, seq: number) => ({
  id: `${channelId}-m${seq}`, seq, channelId, senderType: "user" as const, senderId: "other", senderName: "Ada",
  messageType: "chat" as const, content: `m${seq}`, createdAt: "2026-11-19T00:00:00.000Z", reactions: [], actionMetadata: null,
});
const range = (channelId: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => msg(channelId, from + i));

beforeEach(() => {
  storage.clear();
  resetReadStateSyncForTests();
  __resetResumeWindowContinuityForTests();
  api.get = (async () => ({ data: [] })) as typeof api.get;
  api.post = (async () => ({ data: { evaluations: [] } })) as typeof api.post;
  useServerStore.setState({ current: { id: SERVER, slug: "s" } as never, serverEpoch: 1 } as never);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  // The person reads another conversation; C was loaded earlier, read through 37.
  useMessageStore.setState({
    currentUserId: VIEWER,
    currentChannelId: OPEN,
    channelMessages: { [C]: [msg(C, 10), msg(C, 37)] as never, [OPEN]: [msg(OPEN, 5)] as never },
    historyFetchedChannels: { [C]: true, [OPEN]: true },
    lastSeq: 37,
  });
  consumeReadStateUpdate({ serverId: SERVER, scopeId: C, maxReadSeq: 37, readStateVersion: 1 });
  useMessageStore.getState().applyReadStateProjection(C);
});

afterEach(() => {
  api.get = originalGet as typeof api.get;
  api.post = originalPost as typeof api.post;
});

function bindings() {
  const list = buildMainLayoutSocketBindings(
    { connected: true, emit() {}, on() {}, off() {}, onAny() {}, offAny() {}, disconnect() {}, connect() {} },
    () => {}, async () => {}, () => {}, () => {},
  );
  return (event: string) => {
    const binding = list.find((item) => item.event === event);
    assert.ok(binding, event);
    return binding.handler as (...args: unknown[]) => void;
  };
}

/** The Activity row the server serves for C: 53 unread, newest activity the reply at seq 120. */
const servedRow = { kind: "channel", channelId: C, unreadCount: 53, hasMention: false, firstUnreadMessageId: `${C}-m52`,
  firstMentionMessageId: null, readStateLatestActivitySeq: "120", lastMessageId: `${C}-m120` } as unknown as InboxItem;
const seqOf = (id: string) => useMessageStore.getState().channelMessages[C]?.find((m) => m.id === id)?.seq ?? null;

/** What the Activity list shows for the row after a re-read (inboxStore applyKnownReadStateProjectionsToItems). */
function shownUnread(): number {
  const projection = getAcceptedReadStateProjection(SERVER, C);
  return projection?.complete ? projectInboxItem(servedRow, projection, seqOf).unreadCount : servedRow.unreadCount;
}

test("a resume cut short leaves C's hole known: a later live reply does not lower the served count", async () => {
  const on = bindings();
  on("connect")();
  // The first page (server RESUME_LIMIT) is other conversations' messages; C's 52…88 are past it.
  on("sync:resume:response")({ messages: range("channel-x", 38, 51), currentSeq: 600, hasMore: true });
  useMessageStore.getState().addMessage(msg(C, 120) as never, "channel-room");

  assert.deepEqual(useMessageStore.getState().channelMessages[C]!.map((m) => m.seq), [10, 37, 120]);
  assert.equal(shownUnread(), 53, "the served count stays (was lowered to 1)");
  assert.equal(useMessageStore.getState().applyReadStateProjection(C).complete, false, "C has a hole");
  assert.equal(useMessageStore.getState().historyFetchedChannels[C], undefined, "opening C reads its latest page");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("a complete resume lifts the hold: C is projected again from everything it missed", async () => {
  const on = bindings();
  on("connect")();
  // A live reply lands before the resume answers: C is not taken as complete yet.
  useMessageStore.getState().addMessage(msg(C, 120) as never, "channel-room");
  assert.equal(shownUnread(), 53, "held until the resume answers");
  on("sync:resume:response")({ messages: range(C, 52, 88), currentSeq: 120, hasMore: false });

  const projection = getAcceptedReadStateProjection(SERVER, C);
  assert.equal(projection?.complete, true);
  assert.equal(projection?.unreadCount, 38, "52…88 and 120");
  assert.equal(useMessageStore.getState().historyFetchedChannels[C], true);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("the open conversation is not held (its own gap tracking re-reads it)", async () => {
  const on = bindings();
  on("connect")();
  assert.equal(useMessageStore.getState().channelWindowMeta[OPEN]?.hasGap ?? false, false);
  assert.equal(useMessageStore.getState().channelWindowMeta[C]?.hasGap, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
});
