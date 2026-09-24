/**
 * RFC 037 four-layer integration — proves the machine works end-to-end
 * with zero network and zero React: transport adapter (L1) → socket bridge
 * (L1) → dispatch/reducer (L2) → projections (L3), with the transition
 * trace tap (I4) observing every hop.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { createInboxDomain } from "../src/store/inboxDomain";
import type { InboxTransition } from "../src/store/events/inboxEvents";
import { installSocketBridge } from "../src/store/socketBridge";
import type { SocketLike } from "../src/store/socketBridge";
import {
  selectInboxAttention,
  selectInboxBadgeText,
} from "../src/store/projections/inboxProjections";
import type { InboxItem } from "../src/store/inboxStore";
import type { InboxWindowFetcher } from "../src/store/transport/inboxTransport";

function channelItem(overrides: Record<string, unknown> = {}): InboxItem {
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
    unreadCount: 1,
    hasMention: false,
    ...overrides,
  } as InboxItem;
}

class FakeSocket implements SocketLike {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on(event: string, handler: (...args: unknown[]) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }
  off(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

test("hydrate via transport → socket patch → projections, traced at every hop", async () => {
  const transitions: InboxTransition[] = [];
  const fetcher: InboxWindowFetcher = async () => ({
    items: [channelItem()],
    hasMore: false,
    totalCount: 1,
    totalUnreadCount: 1,
  });
  const domain = createInboxDomain({
    fetcher,
    onTransition: (t) => transitions.push(t),
  });

  // L1 HTTP → L2: initial window
  await domain.loadWindow({ filter: "all", reset: true });
  assert.equal(domain.store.getState().items.length, 1);
  assert.equal(selectInboxBadgeText(domain.store.getState()), "1");

  // L1 socket → L2: a push for the same channel arrives; NO network involved.
  const socket = new FakeSocket();
  const uninstall = domain.bindSocket(socket, () => ({
    channelName: "general",
    channelType: "channel",
    previousItem: domain.store.getState().items[0] as never,
    mentionsCurrentUser: true,
  }));
  socket.emit("message:new", { id: "m-2", channelId: "ch-1", content: "ping", senderType: "user", senderId: "u-2" });

  const state = domain.store.getState();
  assert.equal(state.totalUnreadCount, 2, "socket patch increments locally");
  assert.equal(selectInboxBadgeText(state), "2");
  // L3 attention decision: the mention outranks plain unread.
  assert.equal(selectInboxAttention(state), "mention");

  // I4: every hop reported to the trace tap.
  assert.deepEqual(
    transitions.map((t) => t.event),
    ["hydrate", "patch:item-upsert"],
  );

  // I2 through the full path: the same socket frame delivered twice is a no-op.
  socket.emit("message:new", { id: "m-2", channelId: "ch-1", content: "ping" });
  assert.equal(domain.store.getState().totalUnreadCount, 2);
  assert.equal(transitions.at(-1)?.touched, 0);

  uninstall();
  assert.equal(socket.listenerCount("message:new"), 0, "uninstall removes bindings");
});

test("no-op transitions preserve state reference identity (zustand contract)", async () => {
  const domain = createInboxDomain({
    fetcher: async () => ({ items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 1 }),
    onTransition: () => {},
  });
  await domain.loadWindow({ filter: "all", reset: true });
  const before = domain.store.getState();
  // Read of an already-read item under "all": touched === 0.
  domain.store.dispatch({ kind: "patch", patch: "item-read", itemKey: "missing" });
  assert.equal(domain.store.getState(), before, "no-op dispatch must not produce a new state object");
});

test("bridge reinstall under the same name never double-subscribes", () => {
  const socket = new FakeSocket();
  let calls = 0;
  const binding = [{ event: "message:new", handler: () => { calls += 1; } }];
  installSocketBridge(socket, "inbox-domain", binding);
  installSocketBridge(socket, "inbox-domain", binding);
  socket.emit("message:new", {});
  assert.equal(calls, 1, "second install replaces the first, not stacks on it");
});

// ── Load-bearing coverage the mutation gate flagged (reconcile + scheduling) ──

test("reconcile() pulls server truth and converges domain state", async () => {
  let payload = { items: [channelItem({ unreadCount: 5 })], hasMore: false, totalCount: 1, totalUnreadCount: 5 };
  const domain = createInboxDomain({ fetcher: async () => payload, onTransition: () => {} });
  await domain.loadWindow({ filter: "all", reset: true });
  assert.equal(domain.store.getState().totalUnreadCount, 5);

  payload = { items: [channelItem({ unreadCount: 1, lastMessageId: "m-9" })], hasMore: false, totalCount: 1, totalUnreadCount: 1 };
  await domain.reconcile();
  const state = domain.store.getState();
  assert.equal(state.totalUnreadCount, 1, "reconcile must apply the fresh server snapshot");
  assert.equal((state.items[0] as { lastMessageId?: string }).lastMessageId, "m-9");
});

test("reconcileSuggested transitions coalesce into a single reconcile pull", async () => {
  let fetchCount = 0;
  const domain = createInboxDomain({
    fetcher: async () => {
      fetchCount += 1;
      return { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 };
    },
    onTransition: () => {},
  });
  // Switch to the narrow mentions filter (new `filter` event), then deliver
  // two unknown-item patches in the same tick: each suggests a reconcile,
  // the wiring must coalesce them into ONE pull.
  domain.store.dispatch({ kind: "filter", filter: "mentions" });
  const t1 = domain.store.dispatch({ kind: "patch", patch: "item-upsert", item: channelItem({ channelId: "x1" }), marker: "mx1" });
  const t2 = domain.store.dispatch({ kind: "patch", patch: "item-upsert", item: channelItem({ channelId: "x2" }), marker: "mx2" });
  assert.equal(t1.reconcileSuggested, true);
  assert.equal(t2.reconcileSuggested, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCount, 1, `burst of reconcile suggestions must coalesce into exactly one pull (got ${fetchCount})`);
});

test("filter event clears the window and a mismatched late hydrate cannot pollute it", () => {
  const domain = createInboxDomain({ fetcher: async () => ({}), onTransition: () => {} });
  domain.store.dispatch({ kind: "hydrate", filter: "all", reset: true, items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 1 });
  domain.store.dispatch({ kind: "filter", filter: "unread" });
  const cleared = domain.store.getState();
  assert.equal(cleared.filter, "unread");
  assert.deepEqual(cleared.items, []);
  // A slow response from the PREVIOUS filter arriving late must be dropped.
  domain.store.dispatch({ kind: "hydrate", filter: "all", reset: true, items: [channelItem()], hasMore: false, totalCount: 1, totalUnreadCount: 1 });
  assert.deepEqual(domain.store.getState().items, [], "stale cross-filter hydrate must not apply");
});

// ── Mutation follow-up (Aiden's named survivors on the bridge glue) ──────────

test("null channel context: message:new dispatches NOTHING and schedules one reconcile", async () => {
  let fetchCount = 0;
  const domain = createInboxDomain({
    fetcher: async () => {
      fetchCount += 1;
      return { items: [], hasMore: false, totalCount: 0, totalUnreadCount: 0 };
    },
    onTransition: () => {},
  });
  const socket = new FakeSocket();
  domain.bindSocket(socket, () => null); // context unresolvable (e.g. dm:new race)
  const before = domain.store.getState();

  socket.emit("message:new", { id: "m-1", channelId: "ch-unknown", content: "hi" });
  assert.equal(domain.store.getState(), before, "no dispatch on unresolvable context");

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fetchCount, 1, "unresolvable context must fall back to exactly one reconcile pull");
});

test("inbox bridge coexists with other named bridges and reinstall touches only its own name", () => {
  const socket = new FakeSocket();
  let otherBridgeCalls = 0;
  installSocketBridge(socket, "main-layout", [
    { event: "message:new", handler: () => { otherBridgeCalls += 1; } },
  ]);

  const domain = createInboxDomain({ fetcher: async () => ({}), onTransition: () => {} });
  const uninstall1 = domain.bindSocket(socket, () => null);
  domain.bindSocket(socket, () => null); // reinstall: replaces ONLY the inbox bridge
  void uninstall1;

  socket.emit("message:new", { id: "m-1", channelId: "c" });
  assert.equal(otherBridgeCalls, 1, "reinstalling the inbox bridge must not disturb other named bridges");
  assert.equal(socket.listenerCount("message:new"), 2, "one listener per live bridge, no stacking");
});
