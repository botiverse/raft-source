// An agent's action card posted into a just-created DM reaches the DM's human
// member live (message:new), as an ordinary DM send does: the card fanout joins
// the DM members' sockets to the DM's room before it emits. A server member
// outside the DM gets nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { asServerId } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { findOrCreateDM } from "../services/channelService";
import { prepareActionCard } from "../services/actionCardsService";
import { socketUserServerRoom } from "../socket/platformScope";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A socket server with real room membership: each socket gets what is emitted to a room it is in. */
function roomIo() {
  const rooms = new Map<string, Set<string>>();
  const received = new Map<string, Array<{ event: string; payload: unknown }>>();
  const room = (name: string) => {
    let set = rooms.get(name);
    if (!set) rooms.set(name, set = new Set());
    return set;
  };
  const connect = (socketId: string, ...socketRooms: string[]) => {
    for (const name of socketRooms) room(name).add(socketId);
    received.set(socketId, []);
  };
  const io = {
    to: (name: string) => ({
      emit: (event: string, payload: unknown) => {
        for (const socketId of room(name)) received.get(socketId)?.push({ event, payload });
        return true;
      },
    }),
    in: (name: string) => ({
      socketsJoin: (target: string) => { for (const socketId of room(name)) room(target).add(socketId); },
    }),
  };
  return { connect, received, io: io as unknown as NonNullable<Parameters<typeof prepareActionCard>[0]["io"]> };
}

test("an action card into a just-created DM reaches the DM's human socket via message:new, and no one else's", async ({ app: _app }) => {
  const owner = await seedUser("dm-card-owner");
  const outsider = await seedUser("dm-card-outsider");
  const server = await createServer("DM Card", `dm-card-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" }).onConflictDoNothing();
  const agent = await createAgent(server.id, `dm-card-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  assert.ok(dm, "the DM is created");

  // Neither socket has joined the new DM's room.
  const { connect, received, io } = roomIo();
  connect("owner-socket", `user:${owner.id}`, socketUserServerRoom(owner.id, server.id));
  connect("outsider-socket", `user:${outsider.id}`, socketUserServerRoom(outsider.id, server.id));

  const card = await prepareActionCard({
    serverId: asServerId(server.id),
    requesterAgentId: agent.id,
    targetChannelId: dm.id,
    agentAuthored: true,
    action: { type: "channel:create", name: `dm-card-room-${randomUUID().slice(0, 6)}`, visibility: "public" },
    io,
  });

  const ownerNews = received.get("owner-socket")!.filter((e) => e.event === "message:new" && (e.payload as { id?: string }).id === card.messageId);
  assert.equal(ownerNews.length, 1, "the DM's human gets the card live");
  assert.equal((ownerNews[0]!.payload as { channelId?: string }).channelId, dm.id);
  assert.deepEqual(received.get("outsider-socket"), [], "a server member outside the DM gets nothing");
});
