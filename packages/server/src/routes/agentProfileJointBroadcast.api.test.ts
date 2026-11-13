import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { jointChannels, jointChannelServers } from "../db/schema";
import { createAgent } from "../services/agentService";
import { addAgent } from "../services/channelService";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { seedJointChannel } from "../test/integration/jointFixture";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";

const test = createApiTest();

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an agent profile edit pushes actor:updated to active joint peer rooms only, and agent:updated home", async ({ app }) => {
  const owner = await seedUser("actor-updated-home@slock.test", "actor-updated-home");
  const home = await createServer("Actor Updated Home", "actor-updated-home", owner.id);
  const peer = await createServer("Actor Updated Peer", "actor-updated-peer", owner.id);
  const disconnectedPeer = await createServer("Actor Updated Gone", "actor-updated-gone", owner.id);
  const closedPeer = await createServer("Actor Updated Closed", "actor-updated-closed", owner.id);
  const agent = await createAgent(home.id, "actor-updated-agent", { runtime: "codex" });
  const loner = await createAgent(home.id, "actor-updated-loner", { runtime: "codex" });

  const live = await seedJointChannel({ name: "live-joint", serverIds: [home.id, peer.id, disconnectedPeer.id], createdByUserId: owner.id });
  const closed = await seedJointChannel({ name: "closed-joint", serverIds: [home.id, closedPeer.id], createdByUserId: owner.id });
  await addAgent(live.projections[0]!.id, agent.id);
  await addAgent(closed.projections[0]!.id, agent.id);
  await getDb().update(jointChannelServers)
    .set({ status: "disconnected", disconnectedAt: new Date() })
    .where(eq(jointChannelServers.localChannelId, live.projections[2]!.id));
  await getDb().update(jointChannels).set({ status: "closed" }).where(eq(jointChannels.id, closed.jointChannelId));

  const events = installFakeIo(app.app);
  const actorUpdates = () => events.filter((entry) => entry.event === "actor:updated");
  const token = await tokenForHuman(owner.email);

  const patch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: headers(token, home.id),
    body: JSON.stringify({ displayName: "Renamed Agent", avatarUrl: "pixel:mug" }),
  });
  assert.equal(patch.status, 200);

  assert.deepEqual(
    events.filter((entry) => entry.event === "agent:updated"),
    [{ room: `server:${home.id}`, event: "agent:updated", payload: { agentId: agent.id } }],
    "the home server keeps its id-only push",
  );
  await waitFor(() => actorUpdates().length > 0, "actor:updated");
  assert.deepEqual(actorUpdates(), [{
    room: `channel:${live.projections[1]!.id}`,
    event: "actor:updated",
    payload: {
      kind: "agent",
      id: agent.id,
      homeServerId: home.id,
      name: "actor-updated-agent",
      displayName: "Renamed Agent",
      avatarUrl: "pixel:mug",
    },
  }], "only the active peer projection of the active joint channel gets the external profile");

  // An agent in no joint channel: the home push only.
  events.length = 0;
  const lonerPatch = await fetch(`${app.baseUrl}/api/agents/${loner.id}`, {
    method: "PATCH",
    headers: headers(token, home.id),
    body: JSON.stringify({ displayName: "Still Local" }),
  });
  assert.equal(lonerPatch.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(events.map((entry) => entry.event).filter((event) => event.endsWith(":updated")), ["agent:updated"]);
});
