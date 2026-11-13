import assert from "node:assert/strict";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { serverMembers } from "../db/schema";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addHuman, createChannel, findOrCreateDM, findOrCreateUserDM, listChannels, listDMChannels } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

type PgliteLike = { query: (...args: unknown[]) => Promise<unknown> };

/**
 * Every statement `run` sends, and how many were in flight when each started.
 * A statement that starts with nothing in flight waits for all the ones
 * before it: that count is the sequential depth.
 */
async function measureRoundTrips<T>(run: () => Promise<T>) {
  const pg = (getDb() as unknown as { $client: PgliteLike }).$client;
  const originalQuery = pg.query.bind(pg);
  const counts = { inFlight: 0, maxInFlight: 0, statements: 0, sequentialDepth: 0 };
  pg.query = (async (...args: unknown[]) => {
    counts.statements += 1;
    if (counts.inFlight === 0) counts.sequentialDepth += 1;
    counts.inFlight += 1;
    counts.maxInFlight = Math.max(counts.maxInFlight, counts.inFlight);
    try {
      return await originalQuery(...args);
    } finally {
      counts.inFlight -= 1;
    }
  }) as PgliteLike["query"];
  try {
    return { result: await run(), ...counts };
  } finally {
    pg.query = originalQuery;
  }
}

test("GET /servers/:id/sidebar-order reads channels, DMs and the stored order in a few sequential waves", async ({ app }) => {
  const owner = await seedUser("sidebar-waves-owner@slock.test", "sidebar-waves-owner");
  const peer = await seedUser("sidebar-waves-peer@slock.test", "sidebar-waves-peer");
  const server = await createServer("Sidebar Waves Server", "sidebar-waves-server", owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, "sidebar-waves-channel");
  await addHuman(channel.id, owner.id);
  await createMessage(channel.id, "user", owner.id, "channel message");
  const agent = await createAgent(server.id, "sidebar-waves-agent", { runtime: "codex" });
  const agentDm = await findOrCreateDM(server.id, owner.id, agent.id);
  const userDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  await findOrCreateUserDM(server.id, owner.id, owner.id);
  assert.ok(agentDm && userDm);
  await createMessage(agentDm.id, "user", owner.id, "agent dm message");
  await createMessage(userDm.id, "user", peer.id, "user dm message");
  const token = await tokenForHuman(owner.email);
  const load = () => fetch(`${app.baseUrl}/api/servers/${server.id}/sidebar-order`, { headers: headers(token, server.id) });
  // Warm per-process caches (auth, plan) so the measured load is the steady state.
  assert.equal((await load()).status, 200);

  const measured = await measureRoundTrips(async () => {
    const res = await load();
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
  });

  const dms = await measureRoundTrips(() => listDMChannels(server.id, owner.id));
  const channels = await measureRoundTrips(() => listChannels(server.id, owner.id));
  assert.equal(dms.result.length, 3);
  assert.equal(channels.result.some((row) => row.id === channel.id), true);

  // Before: the DM list was 8 sequential statements (role, agent / user /
  // self DMs, mute, display prefs, read state, last message) and the channel
  // list 7. Now the DM peers are one statement next to the role check, and
  // the per-user state loads side by side, at most 3 at once.
  assert.ok(dms.sequentialDepth <= 3, `DM list depth ${dms.sequentialDepth} for ${dms.statements} statements`);
  assert.ok(dms.maxInFlight <= 3, `DM list in flight ${dms.maxInFlight}`);
  assert.ok(channels.sequentialDepth <= 4, `channel list depth ${channels.sequentialDepth} for ${channels.statements} statements`);
  assert.ok(channels.maxInFlight <= 3, `channel list in flight ${channels.maxInFlight}`);
  // The whole route (auth, membership, then everything above side by side):
  // 25 statements at depth 8 before, in this fixture.
  assert.ok(measured.statements >= 15, `the load still sends every read (${measured.statements})`);
  assert.ok(
    measured.sequentialDepth <= 7,
    `sequential depth ${measured.sequentialDepth} for ${measured.statements} statements (max in flight ${measured.maxInFlight})`,
  );
});

test("GET /servers/:id/sidebar-order drops stored ids that are not uuids or not visible", async ({ app }) => {
  const owner = await seedUser("sidebar-sanitize-owner@slock.test", "sidebar-sanitize-owner");
  const peer = await seedUser("sidebar-sanitize-peer@slock.test", "sidebar-sanitize-peer");
  const server = await createServer("Sidebar Sanitize Server", "sidebar-sanitize-server", owner.id);
  await addMember(server.id, peer.id);
  const channel = await createChannel(server.id, "sidebar-sanitize-channel");
  const agent = await createAgent(server.id, "sidebar-sanitize-agent", { runtime: "codex" });
  const userDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(userDm);
  // Stored orders are free-form JSON: stale ids, other servers' ids and
  // non-uuid strings must drop out without failing the uuid comparison.
  const foreignServer = await createServer("Sidebar Sanitize Other", "sidebar-sanitize-other", owner.id);
  const foreignChannel = await createChannel(foreignServer.id, "sidebar-sanitize-foreign");
  await getDb().update(serverMembers).set({
    sidebarChannelOrder: ["not-a-uuid", channel.id, foreignChannel.id, ""],
    sidebarAgentOrder: [agent.id, "system"],
    sidebarDmOrder: [userDm.id, "12345"],
    pinnedOrder: [channel.id, agent.id, userDm.id, "not-a-uuid"],
    hiddenDmIds: ["garbage", userDm.id],
  }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));

  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/sidebar-order`, { headers: headers(token, server.id) });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as {
    channelOrder: string[];
    agentOrder: string[];
    dmOrder: string[];
    pinnedOrder: string[];
    hiddenDmIds: string[];
  };
  assert.deepEqual(body.channelOrder, [channel.id]);
  assert.deepEqual(body.agentOrder, [agent.id]);
  assert.deepEqual(body.dmOrder, [userDm.id]);
  assert.deepEqual(body.pinnedOrder, [channel.id, agent.id, userDm.id]);
  assert.deepEqual(body.hiddenDmIds, [userDm.id]);
});
