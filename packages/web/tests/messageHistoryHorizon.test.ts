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
const { useMessageStore, messageHistoryRequestsSent, __resetMessageHistoryRequestsForTests } = await import("../src/store/messageStore");

const originalGet = api.get;
afterEach(() => {
  api.get = originalGet;
});

function servePage(horizon: string | null) {
  api.get = (async () => ({
    data: { messages: [{ id: "m1", seq: 7, channelId: "c1", content: "hi", senderType: "user", senderId: "u2", createdAt: "2026-10-25T00:00:00Z" }] },
    headers: horizon === null ? {} : { "x-sync-horizon": horizon },
  })) as typeof api.get;
}

test("the first history read's own horizon starts sync:resume, later reads never replace it", async () => {
  __resetMessageHistoryRequestsForTests();
  useMessageStore.setState({ syncHorizon: null });
  servePage("4242");
  await useMessageStore.getState().loadMessages("c1");
  assert.equal(messageHistoryRequestsSent(), 1);
  assert.equal(useMessageStore.getState().syncHorizon, "4242");

  servePage("9999");
  useMessageStore.setState({ syncHorizon: null });
  await useMessageStore.getState().loadMessages("c1");
  assert.equal(useMessageStore.getState().syncHorizon, null, "a read after another history read cannot start the rounds");
});

test("a page without a horizon (an older server) leaves the starting horizon to the socket", async () => {
  __resetMessageHistoryRequestsForTests();
  useMessageStore.setState({ syncHorizon: null });
  servePage(null);
  await useMessageStore.getState().loadMessages("c1");
  assert.equal(useMessageStore.getState().syncHorizon, null);
});

test("a page whose read overlapped another history read does not start the rounds", async () => {
  __resetMessageHistoryRequestsForTests();
  useMessageStore.setState({ syncHorizon: null });
  const releases: Array<() => void> = [];
  api.get = (() => new Promise((resolve) => {
    releases.push(() => resolve({
      data: { messages: [{ id: "m1", seq: 7, channelId: "c1", content: "hi", senderType: "user", senderId: "u2", createdAt: "2026-10-25T00:00:00Z" }] },
      headers: { "x-sync-horizon": "4242" },
    }));
  })) as typeof api.get;
  const page = useMessageStore.getState().loadMessages("c1");
  // Another history read goes out while the first page is in flight.
  void useMessageStore.getState().loadMessages("c2");
  releases[0]();
  await page;
  assert.equal(useMessageStore.getState().syncHorizon, null);
});
