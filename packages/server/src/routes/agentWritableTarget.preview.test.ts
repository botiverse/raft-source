/**
 * Agent typing line: `previewAgentPostTarget` answers where a send would land
 * without creating anything (no thread, no DM), and null for anything the
 * agent could not post to now. Real DB rows (PGlite).
 */
import assert from "node:assert/strict";
import { and, eq, isNull } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import type { Database } from "../db/index";
import { agents, channels, jointChannels, jointChannelServers, messages, serverMembers, servers, users } from "../db/schema";
import {
  addAgent,
  addHuman,
  createChannel,
  findOrCreateAgentDM,
  findOrCreateDM,
  getOrCreateThreadForChannel,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { previewAgentPostTarget, resolveWritableAgentTarget } from "./agentWritableTarget";

async function seed(db: Database, slug: string, userSuffix = "") {
  const [owner, alice, carol] = await db.insert(users).values([
    { email: `${slug}-owner@test.invalid`, name: `${slug}-owner`, passwordHash: "x", emailVerified: true },
    { email: `${slug}-alice@test.invalid`, name: `alice${userSuffix}`, passwordHash: "x", emailVerified: true },
    { email: `${slug}-carol@test.invalid`, name: `carol${userSuffix}`, passwordHash: "x", emailVerified: true },
  ]).returning();
  const [server] = await db.insert(servers).values({ name: slug, slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values([
    { serverId: server!.id, userId: owner!.id, role: "owner" },
    { serverId: server!.id, userId: alice!.id, role: "member" },
    { serverId: server!.id, userId: carol!.id, role: "member" },
  ]);
  const [niko, peer, loner] = await db.insert(agents).values([
    { serverId: server!.id, name: "Niko", status: "active" },
    { serverId: server!.id, name: "Peer", status: "active" },
    { serverId: server!.id, name: "Loner", status: "active" },
  ]).returning();
  const general = await createChannel(server!.id, "general");
  await addHuman(general.id, alice!.id);
  await addAgent(general.id, niko!.id);
  const secret = await createChannel(server!.id, "secret", undefined, "private");
  await addHuman(secret.id, alice!.id);
  const closed = await createChannel(server!.id, "closed");
  await addAgent(closed.id, niko!.id);
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, closed.id));
  const root = await createMessage(general.id, "user", alice!.id, "root message");
  return { server: server!, alice: alice!, carol: carol!, niko: niko!, peer: peer!, loner: loner!, general, secret, closed, root };
}

async function dmCount(db: Database, serverId: string): Promise<number> {
  const rows = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.type, "dm"), isNull(channels.deletedAt)));
  return rows.length;
}

async function threadCount(db: Database, serverId: string): Promise<number> {
  const rows = await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.serverId, serverId), eq(channels.type, "thread")));
  return rows.length;
}

test("#chan resolves to a channel the agent may post to", async ({ db }) => {
  const s = await seed(db, "tp-chan");
  assert.deepEqual(await previewAgentPostTarget(s.server.id, s.niko.id, "#general"), { channelId: s.general.id, parentMessageId: null });
});

test("#chan:shortid resolves to the parent channel and root message, creating no thread", async ({ db }) => {
  const s = await seed(db, "tp-thread");
  const shortId = s.root.id.slice(0, 8);
  const before = await threadCount(db, s.server.id);
  assert.deepEqual(
    await previewAgentPostTarget(s.server.id, s.niko.id, `#general:${shortId}`),
    { channelId: s.general.id, parentMessageId: s.root.id },
  );
  assert.equal(await threadCount(db, s.server.id), before, "no thread created");

  // An existing thread resolves the same way (the line lives in the parent's room).
  const thread = await getOrCreateThreadForChannel(s.general.id, s.root.id, s.alice.id, "user");
  assert.deepEqual(
    await previewAgentPostTarget(s.server.id, s.niko.id, `#general:${shortId}`),
    { channelId: s.general.id, parentMessageId: s.root.id },
  );
  // The thread channel's own short id names the same root.
  assert.deepEqual(
    await previewAgentPostTarget(s.server.id, s.niko.id, `#general:${thread.id.slice(0, 8)}`),
    { channelId: s.general.id, parentMessageId: s.root.id },
  );
});

test("a short id that is not a root message of that channel resolves to nothing", async ({ db }) => {
  const s = await seed(db, "tp-badroot");
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#general:00000000"), null);
  // The root lives in #general, not #closed / #secret.
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, `#secret:${s.root.id.slice(0, 8)}`), null);
});

test("no permission: non-member private channel, archived channel, unknown channel", async ({ db }) => {
  const s = await seed(db, "tp-perm");
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#secret"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#closed"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#nope"), null);
  // A public channel the agent is not a member of: the send path refuses it too.
  const lobby = await createChannel(s.server.id, "lobby");
  await addHuman(lobby.id, s.alice.id);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#lobby"), null);
  // Not a member of the parent: no thread target either.
  const lobbyRoot = await createMessage(lobby.id, "user", s.alice.id, "lobby root");
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, `#lobby:${lobbyRoot.id.slice(0, 8)}`), null);
});

test("wrong server: a same-named channel elsewhere is not resolved", async ({ db }) => {
  const s = await seed(db, "tp-srv-a");
  const other = await seed(db, "tp-srv-b", "-b");
  // Niko of server A asks about server B's #general and B's root.
  assert.equal(await previewAgentPostTarget(other.server.id, s.niko.id, "#general"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, `#general:${other.root.id.slice(0, 8)}`), null);
});

test("dm:@name resolves only an EXISTING DM and never creates one", async ({ db }) => {
  const s = await seed(db, "tp-dm");
  const before = await dmCount(db, s.server.id);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@alice"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@Peer"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@nobody"), null);
  assert.equal(await dmCount(db, s.server.id), before, "no DM created");

  const aliceDm = await findOrCreateDM(s.server.id, s.alice.id, s.niko.id);
  const peerDm = await findOrCreateAgentDM(s.server.id, s.niko.id, s.peer.id);
  assert.ok(aliceDm && peerDm);
  assert.deepEqual(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@alice"), { channelId: aliceDm.id, parentMessageId: null });
  assert.deepEqual(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@alice~human"), { channelId: aliceDm.id, parentMessageId: null });
  assert.deepEqual(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@Peer~agent"), { channelId: peerDm.id, parentMessageId: null });
  assert.deepEqual(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@Peer"), { channelId: peerDm.id, parentMessageId: null });
  // Wrong kind, or another agent's DM: nothing.
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@alice~agent"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.loner.id, "dm:@alice"), null);
  // A DM thread: parent DM + root.
  const dmRoot = await createMessage(aliceDm.id, "user", s.alice.id, "dm root");
  assert.deepEqual(
    await previewAgentPostTarget(s.server.id, s.niko.id, `dm:@alice:${dmRoot.id.slice(0, 8)}`),
    { channelId: aliceDm.id, parentMessageId: dmRoot.id },
  );
  assert.equal(await dmCount(db, s.server.id), before + 2);
});

test("ambiguous, malformed, reserved and oversized targets resolve to nothing", async ({ db }) => {
  const s = await seed(db, "tp-ambig");
  // An agent named like a human member: a bare name is ambiguous.
  await db.insert(agents).values({ serverId: s.server.id, name: "carol", status: "active" });
  await findOrCreateDM(s.server.id, s.carol.id, s.niko.id);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@carol"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@carol~robot"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "dm:@reminders"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "general"), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, ""), null);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, `#${"x".repeat(600)}`), null);
});

test("a joint channel and a thread under one resolve to nothing", async ({ db }) => {
  const s = await seed(db, "tp-joint");
  const [hostServer] = await db.insert(servers).values({ name: "tp-joint-host", slug: "tp-joint-host", ownerId: s.alice.id }).returning();
  const [local, canonical] = await db.insert(channels).values([
    { serverId: s.server.id, name: "partners", type: "joint" },
    { serverId: hostServer!.id, name: "partners", type: "channel" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: hostServer!.id, createdByUserId: s.alice.id }).returning();
  await db.insert(jointChannelServers).values({ jointChannelId: joint!.id, serverId: s.server.id, localChannelId: local!.id, role: "participant", joinedByUserId: s.alice.id });
  await addAgent(local!.id, s.niko.id);
  const [root] = await db.insert(messages).values({ channelId: canonical!.id, senderType: "user", senderId: s.alice.id, content: "joint root" }).returning();

  // The send path would post there; the typing line does not (its room fan-out runs through projections).
  assert.deepEqual(await resolveWritableAgentTarget(s.server.id, s.niko.id, "#partners"), { channelId: local!.id, type: "joint" });
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, "#partners"), null);
  const before = await threadCount(db, s.server.id);
  assert.equal(await previewAgentPostTarget(s.server.id, s.niko.id, `#partners:${root!.id.slice(0, 8)}`), null);
  assert.equal(await threadCount(db, s.server.id), before, "no thread created");
});
