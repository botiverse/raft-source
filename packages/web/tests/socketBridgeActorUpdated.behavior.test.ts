/** `actor:updated`: another server's agent, seen through a joint channel, changed its profile. */
import "./helpers/domSetup";

import assert from "node:assert/strict";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { actorKey, actorsTable } from "../src/store/localTables";
import type { ServerScope } from "../src/store/localTables";
import { resetActorResolve, setActorScopeUserIdGetter } from "../src/store/localTables/actorResolve";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useServerStore } from "../src/store/serverStore";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const PEER_SERVER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const scope: ServerScope = { userId: "me", serverId: SERVER_ID };

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

const originalGet = api.get.bind(api);
let agentListReads = 0;

beforeEach(() => {
  agentListReads = 0;
  api.get = (async (url: string) => {
    if (url === "/agents") agentListReads += 1;
    return { data: [] };
  }) as typeof api.get;
  setActorScopeUserIdGetter(() => "me");
  useServerStore.setState({ current: { id: SERVER_ID, slug: "acme" } } as never);
  actorsTable.clear(scope);
});

afterEach(() => {
  api.get = originalGet;
  actorsTable.clear(scope);
  resetActorResolve();
  setActorScopeUserIdGetter(null);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
});

function pushActorUpdated(payload: unknown) {
  const bindings = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined);
  const binding = bindings.find((candidate) => candidate.event === "actor:updated");
  assert.ok(binding, "missing actor:updated binding");
  binding.handler(payload);
}

const valid = {
  kind: "agent",
  id: AGENT_ID,
  homeServerId: PEER_SERVER_ID,
  name: "peer-bot",
  displayName: "Peer Bot",
  avatarUrl: "/avatars/peer-bot.webp",
};

test("actor:updated upserts the agent's row in the current scope without re-reading /agents", async () => {
  actorsTable.upsert(scope, [{ kind: "agent", id: AGENT_ID, homeServerId: PEER_SERVER_ID, name: "peer-bot", displayName: "Old", avatarUrl: null }]);
  pushActorUpdated(valid);
  assert.deepEqual(actorsTable.get(scope, actorKey("agent", AGENT_ID)), {
    kind: "agent",
    id: AGENT_ID,
    homeServerId: PEER_SERVER_ID,
    name: "peer-bot",
    displayName: "Peer Bot",
    avatarUrl: "/avatars/peer-bot.webp",
  });

  pushActorUpdated({ ...valid, displayName: null, avatarUrl: null });
  assert.equal(actorsTable.get(scope, actorKey("agent", AGENT_ID))?.displayName, null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(agentListReads, 0, "an external agent's update must not reload this server's agent list");
});

test("actor:updated ignores malformed payloads and humans", () => {
  for (const payload of [
    null,
    "agent",
    { ...valid, kind: "human" },
    { ...valid, kind: "bot" },
    { ...valid, id: "not-a-uuid" },
    { ...valid, homeServerId: undefined },
    { ...valid, name: 42 },
    { ...valid, displayName: 7 },
    { ...valid, avatarUrl: undefined },
  ]) {
    pushActorUpdated(payload);
  }
  assert.equal(actorsTable.get(scope, actorKey("agent", AGENT_ID)), undefined);
  assert.equal(actorsTable.get(scope, actorKey("human", AGENT_ID)), undefined);
});

test("actor:updated without a signed-in scope writes nothing", () => {
  setActorScopeUserIdGetter(null);
  pushActorUpdated(valid);
  assert.equal(actorsTable.get(scope, actorKey("agent", AGENT_ID)), undefined);
});
