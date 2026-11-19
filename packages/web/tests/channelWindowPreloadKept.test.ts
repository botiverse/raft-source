import assert from "node:assert/strict";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });

const { default: api } = await import("../src/api/client");
const { useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { PRELOAD_WINDOW_KEPT_MS, openChannelWindow, openLatestChannelWindow, __resetChannelWindowOpenForTest } = await import("../src/store/channelWindowOpen");
const { preloadServerRoute } = await import("../src/store/preloadServerRoute");
const { latestPagePath } = await import("../src/store/channelPageQuery");

/**
 * The route preload's latest page, once loaded, is taken by ChatPanel's
 * mount (the first opening of the same window) instead of being read again.
 */

const originalGet = api.get;
const originalEnsure = useChannelStore.getState().ensureChannel;
const realNow = Date.now;
let gets: string[] = [];
let release: Array<() => void> = [];
let hold = false;
let failLatestPage = false;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const latestPageReads = (channelId: string) => gets.filter((url) => url === latestPagePath(channelId)).length;

beforeEach(() => {
  gets = [];
  release = [];
  hold = false;
  failLatestPage = false;
  localStorage.clear();
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  __resetChannelWindowOpenForTest();
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  useChannelStore.setState({ ensureChannel: (async () => null) as never });
  api.get = (async (url: string) => {
    gets.push(url);
    if (failLatestPage && url.startsWith("/messages/channel/")) throw Object.assign(new Error("503"), { response: { status: 503 } });
    const page = { data: { messages: [{ id: `${url}-m1`, channelId: "c1", seq: 1, content: "hi", createdAt: new Date(0).toISOString() }] }, headers: {} };
    if (hold) return new Promise((resolve) => { release.push(() => resolve(page)); });
    return page;
  }) as typeof api.get;
});

afterEach(() => {
  api.get = originalGet;
  Date.now = realNow;
  useChannelStore.setState({ ensureChannel: originalEnsure });
});

test("the preload settled before the mount: the mount takes its page, one latest-page read in all", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  assert.equal(latestPageReads("c1"), 1, "the preload's read");
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 1, "the mount joined the settled preload");
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2, "taken once: a later opening loads again");
});

test("a message the socket delivers after the preload and before the mount is still there once the mount takes the kept page", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  assert.equal(latestPageReads("c1"), 1, "the preload's read");
  // A live message arrives between the preload's page and ChatPanel's mount.
  useMessageStore.getState().addMessage({ id: "live-2", channelId: "c1", seq: 2, content: "new", createdAt: new Date(1000).toISOString() } as never, "channel-room");
  const has = () => (useMessageStore.getState().channelMessages.c1 ?? []).some((m) => m.id === "live-2")
    && useMessageStore.getState().messages.some((m) => m.id === "live-2");
  assert.ok(has(), "the live message is in the store before the mount");
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 1, "the mount took the kept page");
  // Taking the kept page applies nothing: it is the page plus what arrived since, never the page in its place.
  assert.ok(has(), "the live message is still there after the mount");
});

test("the preload still loading at the mount: the mount joins it, one read", async () => {
  hold = true;
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  const mount = openChannelWindow("c1", null);
  for (const done of release) done();
  await mount;
  assert.equal(latestPageReads("c1"), 1);
  hold = false;
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2, "joined while loading: nothing kept for a later opening");
});

test("a mount after the bound, or for another conversation, loads itself", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  const landed = Date.now();
  Date.now = () => landed + PRELOAD_WINDOW_KEPT_MS + 1;
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2, "too old: read again");
  Date.now = realNow;

  gets = [];
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  await openChannelWindow("c2", null);
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c2"), 1);
  assert.equal(latestPageReads("c1"), 2, "another window opened in between: the kept page is dropped");
});

test("an ordinary opening is not kept once loaded", async () => {
  await openChannelWindow("c1", null);
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2);
});

test("after a server switch the preload's page is not taken", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  useServerStore.setState({ serverEpoch: useServerStore.getState().serverEpoch + 1 });
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2);
});

test("a failed preload read is not taken, over a cached list too: the mount reads again", async () => {
  await openChannelWindow("c1", null);
  assert.ok(useMessageStore.getState().historyFetchedChannels.c1, "an earlier visit's page is cached");
  failLatestPage = true;
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  failLatestPage = false;
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 3, "the preload's refresh failed: the mount reads again");

  gets = [];
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  failLatestPage = true;
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  failLatestPage = false;
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2, "nothing cached, the read failed");
});

test("another conversation made current without an opening here: the mount reads again", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  useMessageStore.setState({ currentChannelId: "c9" });
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2);
});

test("another person signed in since the preload: the mount reads again", async () => {
  useMessageStore.getState().setCurrentUserId("u1");
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  useMessageStore.getState().setCurrentUserId("u2");
  await openChannelWindow("c1", null);
  assert.equal(latestPageReads("c1"), 2);
});

test("a context load straight through the store since the preload: Back to bottom reads the latest page", async () => {
  preloadServerRoute("/s/acme/channel/c1", "", "u1");
  await settle();
  await useMessageStore.getState().loadMessageContext("c1", "m1");
  assert.ok(gets.some((url) => url === "/messages/context/m1"), "the context window was read");
  await openLatestChannelWindow("c1");
  assert.equal(latestPageReads("c1"), 2);
});
