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
const { requestServerListEarly, useServerStore } = await import("../src/store/serverStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { openChannelWindow, __resetChannelWindowOpenForTest } = await import("../src/store/channelWindowOpen");
const { preloadServerRoute } = await import("../src/store/preloadServerRoute");

function jwt(expSecondsFromNow: number): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub: "u1", type: "access", exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

const originalGet = api.get;
let gets: string[] = [];
let failNext = false;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  gets = [];
  failNext = false;
  localStorage.clear();
  __resetChannelWindowOpenForTest();
  api.get = (async (url: string) => {
    gets.push(url);
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error("403"), { response: { status: 403 } });
    }
    if (url === "/servers") return { data: [{ id: "s1", slug: "acme", name: "Acme" }] };
    return { data: { messages: [] } };
  }) as typeof api.get;
});

afterEach(() => {
  api.get = originalGet;
});

test("the server list asked for early is applied by loadServers, not asked for again", async () => {
  localStorage.setItem("slock_access_token", jwt(600));
  requestServerListEarly();
  assert.deepEqual(gets, ["/servers"], "goes out at boot");
  await useServerStore.getState().loadServers();
  assert.deepEqual(gets.filter((url) => url === "/servers"), ["/servers"], "loadServers took it");
  assert.equal(useServerStore.getState().servers[0]?.slug, "acme");
});

test("an early list for another token, or one that failed, is not applied: loadServers asks itself", async () => {
  localStorage.setItem("slock_access_token", jwt(600));
  requestServerListEarly();
  localStorage.setItem("slock_access_token", jwt(900));
  await useServerStore.getState().loadServers();
  assert.equal(gets.filter((url) => url === "/servers").length, 2, "token changed: asked again");

  gets = [];
  failNext = true;
  requestServerListEarly();
  await settle();
  await useServerStore.getState().loadServers();
  assert.equal(gets.filter((url) => url === "/servers").length, 2, "early one failed (e.g. 403 before verification): asked again");
});

test("no early list without a usable token", () => {
  requestServerListEarly();
  localStorage.setItem("slock_access_token", jwt(-60));
  requestServerListEarly();
  assert.deepEqual(gets, []);
});

test("opening the same conversation window twice while it loads is one load", async () => {
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  const first = openChannelWindow("c1", null);
  const second = openChannelWindow("c1", null);
  assert.equal(first, second);
  await first;
  assert.equal(gets.filter((url) => url.startsWith("/messages/channel/c1")).length, 1);
});

test("the same window opened for another person while it loads is their own load, not a join of the first person's", async () => {
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  useMessageStore.getState().setCurrentUserId("u1");
  try {
    const first = openChannelWindow("c1", null);
    useMessageStore.getState().setCurrentUserId("u2");
    const second = openChannelWindow("c1", null);
    assert.notEqual(second, first, "u1's load is not u2's");
    await Promise.all([first, second]);
    assert.equal(gets.filter((url) => url.startsWith("/messages/channel/c1")).length, 2);
  } finally {
    useMessageStore.getState().setCurrentUserId(null);
  }
});

test("a window opened again after another one is a new load: the store follows the last opening", async () => {
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  const a = openChannelWindow("a", null);
  openChannelWindow("b", null);
  const again = openChannelWindow("a", null);
  assert.notEqual(again, a, "A, B, A: the second A does not join the first");
  await again;
  assert.equal(useMessageStore.getState().currentChannelId, "a");
});

test("preloadServerRoute: a plain link's conversation and latest messages together; thread and message links only the conversation", async () => {
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  const ensured: string[] = [];
  const originalEnsure = useChannelStore.getState().ensureChannel;
  useChannelStore.setState({ ensureChannel: (async (id: string) => { ensured.push(id); return null; }) as never });
  try {
    preloadServerRoute("/s/acme/channel/c1", "", "u1");
    await settle();
    assert.deepEqual(ensured, ["c1"]);
    assert.equal(gets.filter((url) => url.startsWith("/messages/channel/c1")).length, 1);

    gets = [];
    preloadServerRoute("/s/acme/channel/c2", "?thread=c2:m1&msg=m1", "u1");
    preloadServerRoute("/s/acme/dm/d1", "?msg=m9", "u1");
    preloadServerRoute("/s/acme/settings", "", "u1");
    await settle();
    assert.deepEqual(ensured, ["c1", "c2", "d1"], "the conversation itself still preloads");
    assert.deepEqual(gets, [], "no message window for thread or message links, nothing for other pages");
  } finally {
    useChannelStore.setState({ ensureChannel: originalEnsure });
  }
});
