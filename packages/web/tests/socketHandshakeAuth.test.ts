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

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

const { useServerStore } = await import("../src/store/serverStore");
const { getSocket, updateSocketAuthFromStorage } = await import("../src/api/socket");

afterEach(() => {
  getSocket().close();
  localStorage.clear();
  useServerStore.setState({ current: null });
});

test("web socket handshake auth declares clientKind=web and its capabilities", () => {
  localStorage.setItem("slock_access_token", "access-token-1");
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      avatarUrl: null,
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: new Date(0).toISOString(),
    },
  });

  const socket = getSocket();

  assert.deepEqual(socket.auth, {
    token: "access-token-1",
    serverId: "server-1",
    clientKind: "web",
    capabilities: ["agent_activity_subscriptions_v1"],
  });

  localStorage.setItem("slock_access_token", "access-token-2");
  updateSocketAuthFromStorage();

  assert.deepEqual(socket.auth, {
    token: "access-token-2",
    serverId: "server-1",
    clientKind: "web",
    capabilities: ["agent_activity_subscriptions_v1"],
  });
});
