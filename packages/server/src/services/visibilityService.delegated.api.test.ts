// RFC 080 §4.1: the `delegated` actor (an assistant acting for its owner)
// sees what the owner sees, minus the DMs the assistant may not read: none
// when the owner turned DM reading off, and never the assistant's own DM with
// the owner. Threads under an excluded DM go with it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { createServer, seedUser } from "../routes/channels.api.fixtures";
import { createAgent } from "./agentService";
import { setAssistantReadsDms } from "./assistantDmScope";
import { addHuman, createChannel, findOrCreateDM, findOrCreateUserDM, getOrCreateThread } from "./channelService";
import { createMessage } from "./messageService";
import { addMember } from "./serverService";
import { canView, visibleConversationRootIds, visibleRootChannelIds, type ViewActor } from "./visibilityService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedFixture() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`delegated-owner-${suffix}@slock.test`, `delegated-owner-${suffix}`);
  const peer = await seedUser(`delegated-peer-${suffix}@slock.test`, `delegated-peer-${suffix}`);
  const server = await createServer("Delegated Server", `delegated-${suffix}`, owner.id);
  await addMember(server.id, peer.id);

  const room = await createChannel(server.id, `room-${suffix}`);
  await addHuman(room.id, owner.id);
  const roomMessage = await createMessage(room.id, "user", peer.id, "room");
  const roomThread = await getOrCreateThread(roomMessage.id, peer.id, "user");

  const secret = await createChannel(server.id, `secret-${suffix}`, undefined, "private");
  await addHuman(secret.id, peer.id);

  const peerDm = await findOrCreateUserDM(server.id, owner.id, peer.id);
  assert.ok(peerDm);
  const peerDmMessage = await createMessage(peerDm.id, "user", peer.id, "dm");
  const peerDmThread = await getOrCreateThread(peerDmMessage.id, peer.id, "user");

  const assistant = await createAgent(server.id, `assistant-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: owner.id });
  await getDb().update(agents).set({ assistantOwnerUserId: owner.id }).where(eq(agents.id, assistant.id));
  const ownDm = await findOrCreateDM(server.id, owner.id, assistant.id);
  assert.ok(ownDm);
  const ownDmMessage = await createMessage(ownDm.id, "user", owner.id, "hi assistant");
  const ownDmThread = await getOrCreateThread(ownDmMessage.id, owner.id, "user");

  const serverId = asServerId(server.id);
  const delegated: ViewActor = { type: "delegated", id: owner.id, agentId: assistant.id, serverId };
  const asOwner: ViewActor = { type: "user", id: owner.id, serverId };
  return { owner, assistant, room, roomThread, secret, peerDm, peerDmThread, ownDm, ownDmThread, delegated, asOwner };
}

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function visibleSet(actor: ViewActor, ids: readonly string[]): Promise<Set<string>> {
  const answers = await canView(actor, ids.map((channelId) => ({ kind: "conversation" as const, channelId })));
  return new Set(ids.filter((_, index) => answers[index]));
}

function allIds(f: Fixture): string[] {
  return [f.room.id, f.roomThread.id, f.secret.id, f.peerDm.id, f.peerDmThread.id, f.ownDm.id, f.ownDmThread.id];
}

test("delegated sees the owner's conversations, owner DMs included, but never the assistant's own DM", async ({ seed: _seed }) => {
  const f = await seedFixture();
  const owner = await visibleSet(f.asOwner, allIds(f));
  assert.deepEqual([...owner].sort(), [f.room.id, f.roomThread.id, f.peerDm.id, f.peerDmThread.id, f.ownDm.id, f.ownDmThread.id].sort());

  const delegated = await visibleSet(f.delegated, allIds(f));
  assert.deepEqual([...delegated].sort(), [f.room.id, f.roomThread.id, f.peerDm.id, f.peerDmThread.id].sort());

  const roots = await visibleRootChannelIds(f.delegated);
  const rootIds = new Set(visibleConversationRootIds(roots));
  assert.ok(rootIds.has(f.room.id));
  assert.ok(rootIds.has(f.peerDm.id));
  assert.ok(!rootIds.has(f.ownDm.id), "the assistant's own DM with the owner is not a delegated root");
  assert.ok(!rootIds.has(f.secret.id));
});

test("delegated sees no DM, and no thread under one, once the owner turns DM reading off; the switch is read live", async ({ seed: _seed }) => {
  const f = await seedFixture();
  await setAssistantReadsDms(f.assistant.id, false);
  const delegated = await visibleSet(f.delegated, allIds(f));
  assert.deepEqual([...delegated].sort(), [f.room.id, f.roomThread.id].sort());
  const rootIds = new Set(visibleConversationRootIds(await visibleRootChannelIds(f.delegated)));
  assert.ok(!rootIds.has(f.peerDm.id));
  assert.ok(!rootIds.has(f.ownDm.id));

  await setAssistantReadsDms(f.assistant.id, true);
  assert.ok((await visibleSet(f.delegated, [f.peerDm.id])).has(f.peerDm.id));
});

test("delegated never widens the owner's view", async ({ seed: _seed }) => {
  const f = await seedFixture();
  const owner = await visibleSet(f.asOwner, allIds(f));
  for (const id of await visibleSet(f.delegated, allIds(f))) assert.ok(owner.has(id), id);
  assert.deepEqual([...await visibleSet(f.delegated, [f.secret.id])], []);
});
