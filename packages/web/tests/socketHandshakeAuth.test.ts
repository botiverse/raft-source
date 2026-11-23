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
const { connectedSocketServerId, ensureSocketForServer, getSocket, onSocketCreated, resetSocket, updateSocketAuthFromStorage } = await import("../src/api/socket");
const { resolveServerFeatureFlagsForTests } = await import("../src/store/serverFeatureFlags");

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

test("connectedSocketServerId names the server the socket connected for, not the one its auth was rewritten to since", () => {
  const serverNamed = (id: string) => ({
    id,
    name: id,
    avatarUrl: null,
    slug: id,
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free" as const,
    planDowngradedAt: null,
    role: "owner" as const,
    createdAt: new Date(0).toISOString(),
  });
  // No flag request, no real handshake: each socket's connect only marks it connected.
  for (const id of ["server-1", "server-2"]) resolveServerFeatureFlagsForTests(id);
  const stop = onSocketCreated((created) => {
    vi.spyOn(created, "connect").mockImplementation(() => {
      created.connected = true;
      return created;
    });
    vi.spyOn(created, "disconnect").mockImplementation(() => {
      created.connected = false;
      return created;
    });
  });
  // The earlier test's socket was made before the spies: a new one.
  resetSocket();
  try {
    localStorage.setItem("slock_access_token", "access-token-1");
    useServerStore.setState({ current: serverNamed("server-1") });
    // The Artifact's own page connects the socket for the server it opened in.
    ensureSocketForServer("server-1");
    const first = getSocket();
    assert.equal(first.connected, true);
    assert.equal(connectedSocketServerId(), "server-1");

    // A server switch, then a token refresh: the auth now names server-2, the socket is still server-1's.
    useServerStore.setState({ current: serverNamed("server-2") });
    localStorage.setItem("slock_access_token", "access-token-2");
    updateSocketAuthFromStorage();
    assert.equal((first.auth as { serverId?: unknown }).serverId, "server-2");
    assert.equal(connectedSocketServerId(), "server-1");

    // So the page's socket for server-2 is made again, not skipped.
    ensureSocketForServer("server-2");
    const second = getSocket();
    assert.notEqual(second, first, "a new socket for the new server");
    assert.equal(first.connected, false);
    assert.equal(connectedSocketServerId(), "server-2");
    ensureSocketForServer("server-2");
    assert.equal(getSocket(), second, "already that server's: kept");

    second.connected = false;
    assert.equal(connectedSocketServerId(), undefined, "undefined while not connected");
  } finally {
    stop();
    getSocket().connected = false;
  }
});
