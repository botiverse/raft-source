/** boot/openServerFromDevice: a server link opens its server from the device's list before GET /servers. */
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
const { isCurrentServerConfirmed, useServerStore } = await import("../src/store/serverStore");
const { actorsTable, serversTable } = await import("../src/store/localTables");
// Registers who the actors table writes for (the token's person until /auth/me answers).
const { useAuthStore } = await import("../src/store/authStore");
const { openServerFromDevice } = await import("../src/boot/openServerFromDevice");
const { __resetChannelWindowOpenForTest } = await import("../src/store/channelWindowOpen");
import type { Server } from "../src/store/serverStore";

function jwt(sub: string, expSeconds = 600): string {
  const b64 = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${b64({ alg: "HS256" })}.${b64({ sub, type: "access", exp: Math.floor(Date.now() / 1000) + expSeconds })}.sig`;
}

const acme = { id: "s1", slug: "acme", name: "Acme" } as Server;
const originalGet = api.get;
const originalPost = api.post;
let gets: string[] = [];
let posts: string[] = [];
let networkServers: Server[] = [acme];
let messagesPage: unknown[] = [];
let failServers = false;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
let user = 0;

beforeEach(() => {
  gets = [];
  posts = [];
  networkServers = [acme];
  messagesPage = [];
  failServers = false;
  localStorage.clear();
  __resetChannelWindowOpenForTest();
  useServerStore.setState({ servers: [], current: null, loading: true });
  api.get = (async (url: string) => {
    gets.push(url);
    if (url === "/servers") {
      if (failServers) throw Object.assign(new Error("503"), { response: { status: 503 } });
      return { data: networkServers };
    }
    if (url.endsWith("/members")) return { data: [{ userId: "m1", name: "mia", displayName: null, avatarUrl: null, role: "member" }] };
    return { data: url.startsWith("/messages") ? { messages: messagesPage } : {} };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    posts.push(url);
    return { data: {} };
  }) as typeof api.post;
});

afterEach(() => {
  api.get = originalGet;
  api.post = originalPost;
});

/** A fresh person per test: tables are module state. */
function signedInWithDeviceList(servers: Server[]) {
  const userId = `u${++user}`;
  const token = jwt(userId);
  localStorage.setItem("slock_access_token", token);
  // As at boot: the auth store holds the stored token, /auth/me has not answered.
  useAuthStore.setState({ accessToken: token, user: null });
  serversTable.hydrate({ userId }, servers);
  return userId;
}

test("the link's server becomes current from the device and its conversation is asked for before GET /servers", async () => {
  signedInWithDeviceList([acme]);
  const opened = await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  assert.equal(opened, true);
  assert.equal(useServerStore.getState().current?.id, "s1");
  assert.equal(isCurrentServerConfirmed(), false);
  assert.ok(gets.includes("/channels/c1"), gets.join(", "));
  assert.ok(!gets.includes("/servers"));
});

test("GET /servers confirms it: the per-server loads are not asked for twice", async () => {
  signedInWithDeviceList([acme]);
  await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  await settle();
  const membersBefore = gets.filter((url) => url.endsWith("/members")).length;
  await useServerStore.getState().loadServers();
  assert.equal(isCurrentServerConfirmed(), true);
  assert.equal(useServerStore.getState().current?.id, "s1");
  assert.equal(gets.filter((url) => url.endsWith("/members")).length, membersBefore);
  assert.equal(gets.filter((url) => url.endsWith("/sidebar-order")).length, 1);
});

test("the members loaded before /auth/me reach the actors table, for the token's person", async () => {
  const userId = signedInWithDeviceList([acme]);
  await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  for (let i = 0; i < 3; i++) await settle();
  await useServerStore.getState().loadServers();
  assert.ok(actorsTable.list({ userId, serverId: "s1" }).some((row) => row.id === "m1"), JSON.stringify(actorsTable.list({ userId, serverId: "s1" })));
});

test("a failed GET /servers ends the boot as before: no current server, nothing held", async () => {
  signedInWithDeviceList([acme]);
  await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  failServers = true;
  await useServerStore.getState().loadServers();
  assert.equal(useServerStore.getState().current, null);
  assert.equal(isCurrentServerConfirmed(), true);
});

test("an expired token waits for /auth/me to refresh it: nothing goes out early", async () => {
  const userId = `u${++user}`;
  localStorage.setItem("slock_access_token", jwt(userId, -60));
  serversTable.hydrate({ userId }, [acme]);
  assert.equal(await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve()), false);
  assert.deepEqual(gets, []);
});

test("a server the list no longer has is dropped the way a removal is", async () => {
  signedInWithDeviceList([acme]);
  localStorage.setItem("slock_last_server_slug", "acme");
  await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  networkServers = [];
  await useServerStore.getState().loadServers();
  assert.equal(useServerStore.getState().current, null);
  assert.equal(isCurrentServerConfirmed(), true);
});

test("nothing is written for a server only the device knows: the opened conversation's read waits for the confirmation", async () => {
  signedInWithDeviceList([acme]);
  messagesPage = [{ id: "m1", channelId: "c1", seq: 7, content: "hi", createdAt: "2026-10-25T00:00:00Z" }];
  await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve());
  for (let i = 0; i < 5; i++) await settle();
  assert.ok(gets.some((url) => url.startsWith("/messages/channel/c1")), gets.join(", "));
  assert.deepEqual(posts.filter((url) => url.endsWith("/read")), [], "not before GET /servers");
  await useServerStore.getState().loadServers();
  await settle();
  assert.deepEqual(posts.filter((url) => url.endsWith("/read")), ["/channels/c1/read"], "sent once confirmed");
});

test("no session, no device list, a list already from the network, or another slug: nothing happens", async () => {
  assert.equal(await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve()), false, "no session");
  const userId = signedInWithDeviceList([acme]);
  assert.equal(await openServerFromDevice({ pathname: "/s/other/channel/c1", search: "" }, Promise.resolve()), false, "slug not on the device");
  assert.equal(await openServerFromDevice({ pathname: "/", search: "" }, Promise.resolve()), false, "not a server link");
  serversTable.replaceFromFullList({ userId }, [acme]);
  assert.equal(await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve()), false, "network list already in");
  assert.equal(useServerStore.getState().current, null);
});

test("a server another path already chose is left alone", async () => {
  signedInWithDeviceList([acme]);
  useServerStore.setState({ loading: false });
  assert.equal(await openServerFromDevice({ pathname: "/s/acme/channel/c1", search: "" }, Promise.resolve()), false);
});
