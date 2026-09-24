import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { subscribeChannelMembersChanged } from "../src/store/channelMemberEvents";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import {
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
} from "../src/store/socketBridge";
import { useMessageStore } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";

const server: Server = {
  id: "server-1",
  name: "Design",
  avatarUrl: null,
  slug: "design",
  ownerId: "owner-1",
  onboardingAgentId: null,
  hideHumansFromMembers: false,
  plan: "free",
  planDowngradedAt: null,
  role: "owner",
  createdAt: "2026-07-25T00:00:00.000Z",
};

const socket = {
  connected: true,
  emit: () => undefined,
  on: () => undefined,
  off: () => undefined,
  onAny: () => undefined,
  offAny: () => undefined,
  disconnect: () => undefined,
  connect: () => undefined,
} as unknown as MainLayoutSocketBridgeSocket;

afterEach(() => {
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState({ currentUserId: null });
  localStorage.clear();
});

test("server member and agent roster socket events invalidate all channel snapshots", async () => {
  let memberLoads = 0;
  let agentLoads = 0;
  useServerStore.setState({
    current: server,
    loadMembers: async () => {
      memberLoads += 1;
    },
  });
  useAgentStore.setState({
    loadAgents: async () => {
      agentLoads += 1;
    },
  });

  const invalidations: Array<string | null> = [];
  const unsubscribe = subscribeChannelMembersChanged((channelId) => {
    invalidations.push(channelId);
  });
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const invoke = (event: string, payload: unknown) => {
    const binding = bindings.find((candidate) => candidate.event === event);
    assert.ok(binding, `missing ${event} binding`);
    binding.handler(payload);
  };

  for (const event of [
    "server:member-added",
    "server:member:left",
    "server:member-removed",
    "server:member-updated",
  ]) {
    invoke(event, { serverId: server.id });
  }
  invoke("server:member-removed", { serverId: "server-2" });
  invoke("agent:created", { agent: { id: "agent-1" } });
  invoke("agent:deleted", { agentId: "agent-1" });

  assert.equal(memberLoads, 4);
  assert.equal(agentLoads, 2);
  assert.deepEqual(invalidations, [null, null, null, null, null, null]);
  unsubscribe();
});

test("the current user's role update immediately refreshes server and channel authority", () => {
  let serverLoads = 0;
  let memberLoads = 0;
  let channelLoads = 0;
  let dmLoads = 0;
  useMessageStore.setState({ currentUserId: "user-1" });
  useServerStore.setState({
    current: server,
    loadServers: async () => { serverLoads += 1; },
    loadMembers: async () => { memberLoads += 1; },
  });
  useChannelStore.setState({
    loadChannels: async () => { channelLoads += 1; },
    loadDMChannels: async () => { dmLoads += 1; },
  });

  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const binding = bindings.find((candidate) => candidate.event === "server:member-updated");
  assert.ok(binding);
  binding.handler({ serverId: server.id, userId: "user-1", previousRole: "member", role: "guest" });

  assert.deepEqual({ serverLoads, memberLoads, channelLoads, dmLoads }, {
    serverLoads: 1,
    memberLoads: 1,
    channelLoads: 1,
    dmLoads: 1,
  });
});
