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
const { useAuthStore } = await import("../src/store/authStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useServerStore } = await import("../src/store/serverStore");
const { followSignedInUser } = await import("../src/store/signedInUser");
const { captureReceiverPrivateIngressContext, isReceiverPrivateIngressContextCurrent } = await import("../src/store/receiverPrivateIngress");

const originalGet = api.get;
let stop: () => void = () => {};

beforeEach(() => {
  useServerStore.setState({ current: { id: "s1", slug: "acme" } as never });
  useAuthStore.setState({ user: null, accessToken: null });
  useMessageStore.getState().setCurrentUserId(null);
  useMessageStore.setState({ channelMessages: {}, channelWindowMeta: {}, historyFetchedChannels: {}, currentChannelId: null, loading: false });
});

afterEach(() => {
  stop();
  api.get = originalGet;
  useAuthStore.setState({ user: null, accessToken: null });
});

test("the messages store has whoever the auth store signs in, at once, before anything renders", () => {
  useAuthStore.setState({ user: { id: "u1" } as never });
  stop = followSignedInUser();
  assert.equal(useMessageStore.getState().currentUserId, "u1", "taken when it starts");
  useAuthStore.setState({ user: { id: "u2" } as never });
  assert.equal(useMessageStore.getState().currentUserId, "u2", "a switch is followed in the same tick");
  useAuthStore.setState({ user: null });
  assert.equal(useMessageStore.getState().currentUserId, null, "signing out too");
});

test("a channel's first page sent as soon as the session is restored is kept, not read for no one", async () => {
  stop = followSignedInUser();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  api.get = (async (url: string) => {
    if (url.startsWith("/messages/channel/c1")) {
      await held;
      return { data: { messages: [{ id: "m1", channelId: "c1", seq: 1, content: "hi", senderId: "u2", senderType: "human", createdAt: new Date(0).toISOString() }] } };
    }
    return { data: { messages: [] } };
  }) as typeof api.get;

  // Boot: /auth/me answers, then ChatPanel's mount effect asks for the page,
  // before any parent effect has run.
  useAuthStore.setState({ user: { id: "u1" } as never });
  const load = useMessageStore.getState().loadMessages("c1");
  // What MainLayout's effect used to do once it ran, with the page in flight:
  // the page must already have been asked for this person.
  useMessageStore.getState().setCurrentUserId("u1");
  release();
  await load;

  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
  assert.deepEqual(useMessageStore.getState().channelMessages.c1?.map((m) => m.id), ["m1"]);
});

function accessTokenFor(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ type: "access", sub })).toString("base64url");
  return `h.${payload}.s`;
}

test("a channel's first page sent from the device before /auth/me answers is kept for the session's person", async () => {
  // A reload of a server link: the stored session's token is known, /auth/me
  // has not answered, and openServerFromDevice already asks for the page.
  useAuthStore.setState({ user: null, accessToken: accessTokenFor("u1") });
  stop = followSignedInUser();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  api.get = (async (url: string) => {
    if (url.startsWith("/messages/channel/c1")) {
      await held;
      return { data: { messages: [{ id: "m1", channelId: "c1", seq: 1, content: "hi", senderId: "u2", senderType: "human", createdAt: new Date(0).toISOString() }] } };
    }
    return { data: { messages: [] } };
  }) as typeof api.get;

  const load = useMessageStore.getState().loadMessages("c1");
  // /auth/me answers for the same person while the page is in flight.
  useAuthStore.setState({ user: { id: "u1" } as never });
  release();
  await load;

  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
  assert.deepEqual(useMessageStore.getState().channelMessages.c1?.map((m) => m.id), ["m1"]);
});

test("before /auth/me answers, the messages store has the stored session's person; signing out clears it", () => {
  useAuthStore.setState({ user: null, accessToken: accessTokenFor("u1") });
  stop = followSignedInUser();
  assert.equal(useMessageStore.getState().currentUserId, "u1", "the token's person, before /auth/me");
  useAuthStore.setState({ user: { id: "u1" } as never });
  assert.equal(useMessageStore.getState().currentUserId, "u1", "/auth/me agrees");
  useAuthStore.setState({ accessToken: accessTokenFor("u2") });
  assert.equal(useMessageStore.getState().currentUserId, "u1", "the user, once known, wins over the token");
  useAuthStore.setState({ user: null, accessToken: null });
  assert.equal(useMessageStore.getState().currentUserId, null, "signing out drops both");
});

function pageRow(id: string) {
  return { id, channelId: "c1", seq: 1, content: id, senderId: "u9", senderType: "human", createdAt: new Date(0).toISOString() };
}

/** Reads of `prefix` record who they are for; the first one is held until released. */
function holdFirstRead(prefix: string, data: (id: string) => object) {
  const readFor: (string | null)[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  api.get = (async (url: string) => {
    if (!url.startsWith(prefix)) return { data: { messages: [] } };
    readFor.push(useMessageStore.getState().currentUserId);
    const id = `m${readFor.length}`;
    if (readFor.length === 1) await held;
    return { data: data(id) };
  }) as typeof api.get;
  return { readFor, release: () => release() };
}

test("a channel's page read for the person before a switch is read again for the one signed in now, not left loading", async () => {
  useMessageStore.getState().setCurrentUserId("u1");
  const reads = holdFirstRead("/messages/channel/c1", (id) => ({ messages: [pageRow(id)] }));

  const load = useMessageStore.getState().loadMessages("c1");
  useMessageStore.getState().setCurrentUserId("u2");
  reads.release();
  await load;

  assert.deepEqual(reads.readFor, ["u1", "u2"], "u1's page is dropped and the window read for u2");
  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
  assert.equal(useMessageStore.getState().loading, false);
  assert.deepEqual(useMessageStore.getState().channelMessages.c1?.map((m) => m.id), ["m2"]);
});

test("a window around a message read for the person before a switch is read again for the one signed in now", async () => {
  useMessageStore.getState().setCurrentUserId("u1");
  const reads = holdFirstRead("/messages/context/", (id) => ({ messages: [pageRow(id)], targetMessageId: id, hasOlder: false, hasNewer: false }));

  const load = useMessageStore.getState().loadMessageContext("c1", "m1");
  useMessageStore.getState().setCurrentUserId("u2");
  reads.release();
  await load;

  assert.deepEqual(reads.readFor, ["u1", "u2"]);
  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
  assert.deepEqual(useMessageStore.getState().channelMessages.c1?.map((m) => m.id), ["m2"]);
});

test("a page in flight when its person signs out stops loading and is not read again for no one", async () => {
  useMessageStore.getState().setCurrentUserId("u1");
  const reads = holdFirstRead("/messages/channel/c1", (id) => ({ messages: [pageRow(id)] }));

  const load = useMessageStore.getState().loadMessages("c1");
  useMessageStore.getState().setCurrentUserId(null);
  reads.release();
  await load;

  assert.deepEqual(reads.readFor, ["u1"]);
  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
  assert.equal(useMessageStore.getState().loading, false);
  assert.equal(useMessageStore.getState().channelMessages.c1, undefined, "u1's page is not shown");
});

test("a token refresh for the same person changes nothing in the messages store, not even a notification", () => {
  useAuthStore.setState({ user: { id: "u1" } as never, accessToken: accessTokenFor("u1") });
  stop = followSignedInUser();
  let notified = 0;
  const unsubscribe = useMessageStore.subscribe(() => { notified += 1; });
  try {
    useAuthStore.setState({ accessToken: `${accessTokenFor("u1")}.refreshed` });
    useAuthStore.setState({ user: { id: "u1", name: "Profile edit" } as never });
    assert.equal(notified, 0);
  } finally {
    unsubscribe();
  }
});

test("signing out and back in as the same person starts the messages store afresh for them", () => {
  useAuthStore.setState({ user: { id: "u1" } as never, accessToken: accessTokenFor("u1") });
  stop = followSignedInUser();
  const before = captureReceiverPrivateIngressContext("u1");
  useAuthStore.setState({ user: null, accessToken: null });
  assert.equal(useMessageStore.getState().currentUserId, null, "signed out");
  useAuthStore.setState({ user: { id: "u1" } as never, accessToken: accessTokenFor("u1") });
  assert.equal(useMessageStore.getState().currentUserId, "u1", "signed back in");
  assert.equal(isReceiverPrivateIngressContextCurrent(before), false, "a read from before the sign-out is not theirs any more");
});

test("a page gone stale with its server is not read again: it stops loading, so a stale read cannot loop", async () => {
  useMessageStore.getState().setCurrentUserId("u1");
  const reads = holdFirstRead("/messages/channel/c1", (id) => ({ messages: [pageRow(id)] }));

  const load = useMessageStore.getState().loadMessages("c1");
  useServerStore.setState({ serverEpoch: useServerStore.getState().serverEpoch + 1 });
  reads.release();
  await load;

  assert.deepEqual(reads.readFor, ["u1"]);
  assert.equal(useMessageStore.getState().channelWindowMeta.c1?.loading, false, "not left on the skeleton");
});
