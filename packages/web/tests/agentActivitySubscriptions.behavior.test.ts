/**
 * Agent activity scoped to who is watching (#proj-frontend:#8): the tab's
 * subscriptions (counted, resent after a reconnect), and the coarse state for
 * agents it does not subscribe to.
 */
import assert from "node:assert/strict";
import {
  AGENT_ACTIVITY_SUBSCRIBE_EVENT,
  AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY,
  AGENT_ACTIVITY_UNSUBSCRIBE_EVENT,
} from "@botiverse/raft-shared";
import {
  acquireAgentActivity,
  isAgentActivitySubscribed,
  resetAgentActivitySubscriptionsForTests,
  resubscribeAgentActivity,
  setAgentActivitySubscriptionSocket,
} from "../src/store/agentActivitySubscriptions";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useLiveAgentActivityStore } from "../src/store/liveAgentActivityStore";
import { useServerStore } from "../src/store/serverStore";
import { applyStatusActivityEvent, LIVE_AGENT_ACTIVITY_VISIBLE_MS, nextLiveAgentActivityExpiry, pruneExpiredLiveAgentActivityItems } from "../src/utils/liveAgentActivity";

function recordingSocket() {
  const emits: Array<[string, unknown]> = [];
  return { emits, socket: { connected: true, emit: (event: string, payload: unknown) => { emits.push([event, payload]); } } };
}

function makeAgent(id: string): Agent {
  return {
    id, name: id, displayName: id, avatarUrl: null, description: null, status: "active", model: "sonnet", runtime: "claude",
    reasoningEffort: null, executionMode: "byoc", envVars: null, machineId: "machine-1", runtimeProfile: null,
    creatorType: "user", creatorId: "human-1", creator: null, createdAgents: [], deletedAt: null, createdAt: new Date(0).toISOString(),
  } as Agent;
}

function resetStores() {
  resetAgentActivitySubscriptionsForTests();
  useServerStore.setState({ current: { id: "server-1" } as never });
  useLiveAgentActivityStore.getState().clear();
  useAgentStore.setState({
    agents: [makeAgent("a"), makeAgent("b")],
    agentActivities: {}, agentActivityTraceJoins: {}, agentActivityObservedAt: {}, agentActivityVersions: {},
    agentActivitySeq: {}, agentActivityLaunchId: {}, activityLogs: {}, trajectoryLogs: {}, loading: false,
  } as never);
}

function binding(event: string) {
  const socket = { connected: true, emit: () => undefined, on: () => undefined, off: () => undefined, onAny: () => undefined, offAny: () => undefined, disconnect: () => undefined, connect: () => undefined } as unknown as MainLayoutSocketBridgeSocket;
  const found = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined).find((item) => item.event === event);
  assert.ok(found, event);
  return found.handler as (payload: unknown) => void;
}

beforeEach(() => resetStores());
afterEach(() => resetStores());

test("subscriptions are counted per agent: the first holder subscribes, the last release unsubscribes", () => {
  const { emits, socket } = recordingSocket();
  setAgentActivitySubscriptionSocket(() => socket);
  const releaseDm = acquireAgentActivity(["a"]);
  const releaseMembers = acquireAgentActivity(["a", "b", "a"]);
  assert.deepEqual(emits, [
    [AGENT_ACTIVITY_SUBSCRIBE_EVENT, { agentIds: ["a"] }],
    [AGENT_ACTIVITY_SUBSCRIBE_EVENT, { agentIds: ["b"] }],
  ]);
  assert.equal(isAgentActivitySubscribed("a"), true);
  releaseMembers();
  releaseMembers();
  assert.deepEqual(emits.at(-1), [AGENT_ACTIVITY_UNSUBSCRIBE_EVENT, { agentIds: ["b"] }], "a stays held by the DM; a double release is a no-op");
  assert.equal(isAgentActivitySubscribed("a"), true);
  assert.equal(isAgentActivitySubscribed("b"), false);
  releaseDm();
  assert.deepEqual(emits.at(-1), [AGENT_ACTIVITY_UNSUBSCRIBE_EVENT, { agentIds: ["a"] }]);
  assert.equal(emits.length, 4);
});

test("after a reconnect every held agent is subscribed again (rooms:joined)", () => {
  const { emits, socket } = recordingSocket();
  acquireAgentActivity(["a", "b"]);
  setAgentActivitySubscriptionSocket(() => socket);
  assert.equal(emits.length, 0, "nothing was sent while there was no socket");
  binding("rooms:joined")(undefined);
  assert.deepEqual(emits.filter(([event]) => event === AGENT_ACTIVITY_SUBSCRIBE_EVENT), [[AGENT_ACTIVITY_SUBSCRIBE_EVENT, { agentIds: ["a", "b"] }]]);
  resubscribeAgentActivity();
  assert.equal(emits.filter(([event]) => event === AGENT_ACTIVITY_SUBSCRIBE_EVENT).length, 2);
});

test("a coarse state updates an unsubscribed agent's dot and Working-now row; a subscribed agent keeps its detailed state", () => {
  const coarse = binding("agent:activity_state");
  coarse({ agentId: "a", state: "busy", activity: "working", timestamp: 10, serverSeq: 10 });
  assert.equal(useAgentStore.getState().agentActivities.a?.activity, "working");
  const items = useLiveAgentActivityStore.getState().items;
  assert.deepEqual(items.map((item) => [item.agentId, item.heldUntilChange]), [["a", true]]);

  acquireAgentActivity(["b"]);
  useAgentStore.getState().updateActivity("b", "working", "Editing file", 20, 20);
  coarse({ agentId: "b", state: "online", activity: "online", timestamp: 21, serverSeq: 21 });
  assert.equal(useAgentStore.getState().agentActivities.b?.activity, "working", "the detailed push owns a subscribed agent");
});

test("a row from a coarse state stays until a later state settles it, instead of expiring with no heartbeat", () => {
  const agents = [makeAgent("a")];
  let items = applyStatusActivityEvent([], { agentId: "a", activity: "working", timestamp: 0, fromCoarseState: true }, agents);
  assert.equal(pruneExpiredLiveAgentActivityItems(items, LIVE_AGENT_ACTIVITY_VISIBLE_MS * 10).length, 1);
  assert.equal(nextLiveAgentActivityExpiry(items), null, "nothing to schedule for a held row");
  items = applyStatusActivityEvent(items, { agentId: "a", activity: "online", timestamp: 1_000, fromCoarseState: true }, agents);
  assert.ok(items[0]?.idleSince !== null, "a coarse idle state settles it like an idle push");
  const detailed = applyStatusActivityEvent([], { agentId: "a", activity: "working", timestamp: 0 }, agents);
  assert.equal(pruneExpiredLiveAgentActivityItems(detailed, LIVE_AGENT_ACTIVITY_VISIBLE_MS + 1).length, 0, "a detailed row still expires without its heartbeat");
});

test("the web socket declares the capability", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/api/socket.ts", import.meta.url), "utf8");
  assert.ok(source.includes("capabilities: [AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY]"));
  assert.equal(AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY, "agent_activity_subscriptions_v1");
});
