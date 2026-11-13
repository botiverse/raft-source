import assert from "node:assert/strict";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new MemoryStorage() });

const { getSocket, onSocketCreated, resetSocket } = await import("../src/api/socket");

// task #17: resetSocket()/reconnectSocket() drop every listener on the old
// socket; module-level subscribers (runtime sign-in client) re-attach through
// onSocketCreated.
test("onSocketCreated hears every new socket instance until unsubscribed", () => {
  resetSocket();
  const seen: unknown[] = [];
  const off = onSocketCreated((created) => seen.push(created));
  const first = getSocket();
  assert.equal(getSocket(), first, "the same instance is not announced twice");
  resetSocket();
  const second = getSocket();
  assert.notEqual(second, first);
  assert.deepEqual(seen, [first, second]);
  off();
  resetSocket();
  getSocket();
  assert.equal(seen.length, 2, "an unsubscribed listener hears nothing");
  resetSocket();
});
