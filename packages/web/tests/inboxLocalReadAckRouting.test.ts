import assert from "node:assert/strict";
import type { InboxItem } from "../src/store/inboxStore";

// #triage:#244: every read this tab sends reports its ack to the lowered-row
// report (noteLocalReadAck), not only Activity's Read: a conversation opened
// (or read again on resume, markCurrentChannelRead) and a thread opened. Before,
// their held local_read lowerings always ended `held_end=window`.

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
const { useThreadStore } = await import("../src/store/threadStore");
const { postReadAllCoalesced } = await import("../src/store/transport/inboxTransport");
const { __resetPendingLocalReadsForTest, reportListRowsLowered } = await import("../src/store/inboxListRowLowered");
const { __setStateTransitionEmitterForTest } = await import("../src/utils/stateTransitionTrace");

const originalPost = api.post.bind(api);
const VIEWER = "viewer-1";
const CHANNEL = "channel-1";
const THREAD = "thread-1";

let posts: string[] = [];
let events: Array<Record<string, unknown>> = [];

beforeEach(() => {
  storage.clear();
  posts = [];
  events = [];
  __setStateTransitionEmitterForTest((name, attrs) => {
    if (name === "slock.state.transition") events.push(attrs as Record<string, unknown>);
  });
  // The server acks a read with the read it saved: through seq 5.
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: url.endsWith("/read-all") ? { ok: true, seq: 5, readStateVersion: 2 } : { ok: true, maxReadSeq: 5, readStateVersion: 2 } };
  }) as typeof api.post;
  useServerStore.setState({ current: { id: "server-1" } as never, serverEpoch: 1 } as never);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useMessageStore.setState({ currentUserId: VIEWER });
  useThreadStore.setState(useThreadStore.getInitialState(), true);
});

afterEach(() => {
  api.post = originalPost;
  __resetPendingLocalReadsForTest();
  __setStateTransitionEmitterForTest(null);
});

const eventName = (attrs: Record<string, unknown>) => (attrs as { key?: { event?: string } }).key?.event;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A list answer served the row unread (latest activity 5), and this tab's local read lowered it. */
function lowerByLocalRead(scopeId: string, kind: "channel" | "thread" = "channel") {
  const row = (unreadCount: number) => ({ kind, channelId: scopeId, threadChannelId: scopeId, unreadCount, hasMention: false } as unknown as InboxItem);
  reportListRowsLowered({
    served: [row(4)],
    servedFrontiers: [{ kind: "present", readStateVersion: 1, maxReadSeq: "1", latestActivity: { messageId: "m5", seq: "5" } } as never],
    ledgerOf: () => null,
    before: [row(4)],
    stages: [["ledger", [row(4)]], ["local_read", [row(0)]], ["projection", [row(0)]]],
    reason: "realtime_fallback", trigger: "message_new", rowPosition: true, now: Date.now(),
  });
}

function openChannelAtBottom() {
  const messages = [1, 2, 3, 4, 5].map((seq) => ({ id: `m${seq}`, seq, channelId: CHANNEL, senderType: "user", senderId: "user-2", senderName: "Lin", content: "x", createdAt: "2026-11-19T00:00:00.000Z" }));
  useMessageStore.setState({
    currentChannelId: CHANNEL, messages, channelMessages: { [CHANNEL]: messages } as never,
    lastSeq: 5, isNearBottom: true, hasNewer: false, unreadCounts: { [CHANNEL]: 4 },
  } as never);
}

test("a conversation read in view (markCurrentChannelRead: opening it, or the page coming back) settles its held lowering by its /read ack", async () => {
  openChannelAtBottom();
  lowerByLocalRead(CHANNEL);
  assert.equal(events.length, 0, "held for the ack");
  useMessageStore.getState().markCurrentChannelRead();
  await settle();
  assert.ok(posts.includes(`/channels/${CHANNEL}/read`));
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.deepEqual(["held_end", "ack_read_seq", "class"].map((k) => events[0][`inbox.lowered.${k}`]), ["ack", "5", "expected"]);
});

test("a thread opened settles its held lowering by its /read-all ack", async () => {
  lowerByLocalRead(THREAD, "thread");
  useThreadStore.getState().clearThreadUnread(THREAD, null);
  await settle();
  assert.ok(posts.includes(`/channels/${THREAD}/read-all`));
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.equal(events[0]["inbox.lowered.held_end"], "ack");
});

test("an ack that landed before the answer registered the hold still settles it (ack_before_hold)", async () => {
  openChannelAtBottom();
  useMessageStore.getState().markCurrentChannelRead();
  await settle();
  lowerByLocalRead(CHANNEL);
  assert.deepEqual(events.map(eventName), ["activity:list_row_corrected"]);
  assert.equal(events[0]["inbox.lowered.held_end"], "ack_before_hold");
  assert.ok(Number(events[0]["inbox.lowered.ack_delay_ms"]) <= 0, "the ack's lead, as a negative delay");
});

test("a read-all on an agent's behalf is not this person's read ack", async () => {
  lowerByLocalRead(THREAD, "thread");
  await postReadAllCoalesced(THREAD, { serverId: "server-1", serverEpoch: 1, principalId: VIEWER, receiver: { kind: "agent", id: "agent-1" } });
  await settle();
  assert.equal(events.length, 0, "still held");
});
