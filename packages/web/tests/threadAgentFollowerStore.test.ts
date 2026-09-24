import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import api from "../src/api/client";
import {
  requestThreadAgentFollowers,
  useThreadAgentFollowerStore,
} from "../src/store/threadAgentFollowerStore";
import {
  buildMainLayoutSocketBindings,
  installSocketBridge,
} from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";

const threadChannelId = "00000000-0000-4000-8000-000000000001";
const otherThreadChannelId = "00000000-0000-4000-8000-000000000002";

function waitForQueuedRosterLoad() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  useThreadAgentFollowerStore.getState().reset();
});

test("thread Agent follower requests can force-refresh an already loaded roster", async (t) => {
  let calls = 0;
  t.mock.method(api, "get", async (url: string, config?: { params?: { threadChannelIds?: string } }) => {
    assert.equal(url, "/channels/threads/followers");
    assert.equal(config?.params?.threadChannelIds, threadChannelId);
    calls += 1;
    return {
      data: {
        threads: [{
          threadChannelId,
          canManage: true,
          agents: calls === 1
            ? [
                { id: "agent-a", name: "agent-a", displayName: "Agent A", status: "online", avatarUrl: null },
                { id: "agent-b", name: "agent-b", displayName: "Agent B", status: "online", avatarUrl: null },
              ]
            : [
                { id: "agent-b", name: "agent-b", displayName: "Agent B", status: "online", avatarUrl: null },
              ],
        }],
      },
    };
  });

  requestThreadAgentFollowers(threadChannelId);
  await waitForQueuedRosterLoad();
  assert.equal(calls, 1);
  assert.equal(useThreadAgentFollowerStore.getState().rosters[threadChannelId]?.agents.length, 2);

  requestThreadAgentFollowers(threadChannelId);
  await waitForQueuedRosterLoad();
  assert.equal(calls, 1, "cached roster requests should not refetch without a realtime refresh");

  requestThreadAgentFollowers(threadChannelId, true);
  await waitForQueuedRosterLoad();
  assert.equal(calls, 2, "realtime refreshes must bypass the loaded roster cache");
  assert.deepEqual(
    useThreadAgentFollowerStore.getState().rosters[threadChannelId]?.agents.map((agent) => agent.id),
    ["agent-b"],
  );
});

test("socketBridge follower updates force-refresh only the changed loaded roster and clean up", async (t) => {
  let calls = 0;
  t.mock.method(api, "get", async (url: string, config?: { params?: { threadChannelIds?: string } }) => {
    assert.equal(url, "/channels/threads/followers");
    assert.equal(config?.params?.threadChannelIds, threadChannelId);
    calls += 1;
    return {
      data: {
        threads: [{
          threadChannelId,
          canManage: true,
          agents: calls === 1
            ? [
                { id: "agent-a", name: "agent-a", displayName: "Agent A", status: "online", avatarUrl: null },
                { id: "agent-b", name: "agent-b", displayName: "Agent B", status: "online", avatarUrl: null },
              ]
            : [
                { id: "agent-b", name: "agent-b", displayName: "Agent B", status: "online", avatarUrl: null },
              ],
        }],
      },
    };
  });

  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const socket: MainLayoutSocketBridgeSocket = {
    connected: true,
    emit: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const eventHandlers = handlers.get(event) ?? new Set<(...args: unknown[]) => void>();
      eventHandlers.add(handler);
      handlers.set(event, eventHandlers);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    },
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const uninstall = installSocketBridge(socket, "thread-followers-test", bindings);

  requestThreadAgentFollowers(threadChannelId);
  await waitForQueuedRosterLoad();
  assert.equal(calls, 1);
  assert.deepEqual(
    useThreadAgentFollowerStore.getState().rosters[threadChannelId]?.agents.map((agent) => agent.id),
    ["agent-a", "agent-b"],
  );

  socket.emit("thread:followers-updated", { threadChannelId: otherThreadChannelId });
  await waitForQueuedRosterLoad();
  assert.equal(calls, 1, "updates for another thread must not refresh this roster");

  socket.emit("thread:followers-updated", { threadChannelId });
  await waitForQueuedRosterLoad();
  assert.equal(calls, 2, "dedicated follower updates must bypass the loaded roster cache");
  assert.deepEqual(
    useThreadAgentFollowerStore.getState().rosters[threadChannelId]?.agents.map((agent) => agent.id),
    ["agent-b"],
  );

  uninstall();
  socket.emit("thread:followers-updated", { threadChannelId });
  await waitForQueuedRosterLoad();
  assert.equal(calls, 2, "bridge cleanup must remove the follower-update handler it installed");
});
