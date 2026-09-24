import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

const { useServerStore } = await import("../src/store/serverStore.js");
const { getSocket } = await import("../src/api/socket.js");
const { applyHostAccessOnlyToken, useAuthStore } = await import("../src/store/authStore.js");

afterEach(() => {
  getSocket().close();
  localStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
  useServerStore.setState({ current: null });
});

test("host access-only commit updates Zustand and cached socket auth without consuming RT", () => {
  localStorage.setItem("slock_access_token", "access-new");
  localStorage.setItem("slock_refresh_token", "must-remain-untouched");
  useAuthStore.setState({
    user: { id: "account-1" } as never,
    accessToken: "access-old",
    refreshToken: "must-be-cleared",
  });
  useServerStore.setState({ current: { id: "server-1" } as never });
  const socket = getSocket();
  const oldAuth = socket.auth;

  applyHostAccessOnlyToken("access-new");

  assert.equal(useAuthStore.getState().accessToken, "access-new");
  assert.equal(useAuthStore.getState().refreshToken, null);
  assert.equal(
    localStorage.getItem("slock_refresh_token"),
    "must-remain-untouched",
    "host rotation must not read, rewrite, or clear persisted refresh-token state",
  );
  assert.notEqual(socket.auth, oldAuth);
  assert.deepEqual(socket.auth, {
    token: "access-new",
    serverId: "server-1",
    clientKind: "web",
  });

  const updatedAuth = socket.auth;
  applyHostAccessOnlyToken("access-new");
  assert.equal(socket.auth, updatedAuth, "duplicate token must not churn socket auth or reconnect");
});
