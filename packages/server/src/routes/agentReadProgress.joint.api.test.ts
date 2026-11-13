/**
 * Agent read progress in a joint channel (agentReadProgressService.ts, "Joint
 * channels"; artin, #botiverse-raft-deployment msgs 8837d73c, 90309626,
 * 9b3f12dc): each server's people watch their own projection, and see the
 * agents of both servers, in the channel detail and in live frames; a
 * person's read position is never exposed; the viewer's own server's flag
 * decides whether that viewer watches and gets frames. Who a message will not
 * reach (an agent's stopped follow, its mute of the channel) is on its own
 * server's projection, and every side's detail and open views hear of it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import {
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  READ_PROGRESS_DETAIL_CHANGED_EVENT,
  READ_PROGRESS_UPDATED_EVENT,
  READ_PROGRESS_WATCH_EVENT,
  READ_PROGRESS_WATCHED_EVENT,
  readProgressRoom,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentChannelReadCursors, featureFlagRules, servers as serversTable } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  acceptJointChannelInvite,
  addAgent,
  createJointChannel,
  getActiveJointChannelProjectionsByLocalChannel,
  getActiveJointThreadProjectionsByCanonicalThread,
  getOrCreateThreadForChannel,
  markAgentLegacyRead,
  markRead,
  recordThreadFollow,
  unfollowThreadForFollower,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { __resetAgentReadProgressForTests } from "../services/agentReadProgressService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// Twice the flush interval: long enough that a frame that was going to come has come.
const QUIET_MS = 700;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitEvent = (socket: any, event: string, timeoutMs = 4_000) => new Promise<any>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: any) => { clearTimeout(timer); resolve(value); });
});

function collect(socket: any, event: string): unknown[] {
  const received: unknown[] = [];
  socket.on(event, (payload: unknown) => received.push(payload));
  return received;
}

async function connect(baseUrl: string, token: string, serverId: string) {
  const socket = clientIo(baseUrl, { auth: { token, serverId }, transports: ["websocket"], autoConnect: false });
  const ready = waitEvent(socket, "rooms:joined");
  socket.connect();
  await ready;
  return socket;
}

async function watch(socket: any, scopeId: string): Promise<{ scopeId: string; ok: boolean }> {
  const answer = waitEvent(socket, READ_PROGRESS_WATCHED_EVENT);
  socket.emit(READ_PROGRESS_WATCH_EVENT, { scopeId });
  return answer;
}

async function enableAgentReadProgress(serverId: string) {
  await getDb().insert(featureFlagRules).values({
    flagKey: AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

async function founderServer(label: string, ownerId: string) {
  const server = await createServer(`${label} server`, `${label}-${randomUUID().slice(0, 8)}`, ownerId);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return server;
}

async function setAgentCursor(agentId: string, channelId: string, seq: number) {
  await getDb().insert(agentChannelReadCursors).values({ agentId, channelId, lastReadSeq: seq })
    .onConflictDoUpdate({
      target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId],
      set: { lastReadSeq: seq },
    });
}

/** A joint channel between two servers, one agent on each side, and one message both agents have read. */
async function seedJoint(label: string) {
  __resetAgentReadProgressForTests();
  const hostOwner = await seedUser(`${label}-host-${randomUUID().slice(0, 6)}@slock.test`, `${label}-host`);
  const peerOwner = await seedUser(`${label}-peer-${randomUUID().slice(0, 6)}@slock.test`, `${label}-peer`);
  const host = await founderServer(`${label}-host`, hostOwner.id);
  const peer = await founderServer(`${label}-peer`, peerOwner.id);
  const made = await createJointChannel({
    hostServerId: host.id,
    createdByUserId: hostOwner.id,
    name: `${label}-room`,
    jointInvites: [{ targetServerSlug: peer.slug, invitedPeople: [peerOwner.email] }],
  });
  const hostFace = made.channel;
  const peerFace = await acceptJointChannelInvite({
    inviteId: made.invites[0]!.id,
    targetServerId: peer.id,
    acceptedByUserId: peerOwner.id,
  });
  assert.equal(peerFace.type, "joint");
  const hostAgent = await createAgent(host.id, `${label}-host-agent`);
  const peerAgent = await createAgent(peer.id, `${label}-peer-agent`);
  await addAgent(hostFace.id, hostAgent.id);
  await addAgent(peerFace.id, peerAgent.id);
  // A joint channel's messages live in its canonical channel (each server's projection reads them there).
  const [projection] = await getActiveJointChannelProjectionsByLocalChannel(hostFace.id);
  assert.ok(projection, "the host face is a projection of a joint channel");
  const canonicalId = projection.canonicalChannelId;
  const seen = await createMessage(canonicalId, "user", hostOwner.id, `${label} already read`);
  // Each agent's cursor is on its own server's projection.
  await setAgentCursor(hostAgent.id, hostFace.id, seen.seq);
  await setAgentCursor(peerAgent.id, peerFace.id, seen.seq);
  return {
    host,
    peer,
    hostFace,
    peerFace,
    canonicalId,
    hostAgent,
    peerAgent,
    seen,
    hostOwnerId: hostOwner.id,
    peerOwnerId: peerOwner.id,
    hostToken: await tokenForHuman(hostOwner.email),
    peerToken: await tokenForHuman(peerOwner.email),
  };
}

type Detail = {
  peerReadStates?: Array<{ peerKind: string; peerId: string; maxReadSeq: number; stoppedFollowing?: boolean; mutedChannel?: boolean }>;
  peerReadSummary?: unknown;
};

async function detail(baseUrl: string, token: string, serverId: string, channelId: string): Promise<Detail> {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}`, { headers: headers(token, serverId) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<Detail>;
}

const byPeer = (left: { peerId: string }, right: { peerId: string }) => (left.peerId < right.peerId ? -1 : left.peerId > right.peerId ? 1 : 0);

test("joint: the detail on either side lists both servers' agents at their own positions, and no person", async ({ app }) => {
  const f = await seedJoint("rpj-detail");
  const later = await createMessage(f.canonicalId, "user", f.peerOwnerId, "rpj-detail later");
  await setAgentCursor(f.peerAgent.id, f.peerFace.id, later.seq);
  await markRead(f.peerOwnerId, f.peerFace.id, later.seq);

  const expected = [
    { peerKind: "agent", peerId: f.hostAgent.id, maxReadSeq: f.seen.seq },
    { peerKind: "agent", peerId: f.peerAgent.id, maxReadSeq: later.seq },
  ].sort(byPeer);
  for (const [token, serverId, channelId] of [
    [f.hostToken, f.host.id, f.hostFace.id],
    [f.peerToken, f.peer.id, f.peerFace.id],
  ] as const) {
    const body = await detail(app.baseUrl, token, serverId, channelId);
    assert.equal(body.peerReadSummary, undefined);
    assert.deepEqual([...(body.peerReadStates ?? [])].sort(byPeer), expected);
    assert.equal(body.peerReadStates?.some((state) => state.peerKind === "human"), false, "a person's read position never leaves the server");
  }
});

test("joint: both sides watch their own projection; an agent's move reaches each side under its own id", async ({ app }) => {
  const f = await seedJoint("rpj-live");
  await enableAgentReadProgress(f.host.id);
  await enableAgentReadProgress(f.peer.id);
  const hostWatcher = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerWatcher = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    assert.deepEqual(await watch(hostWatcher, f.hostFace.id), { scopeId: f.hostFace.id, ok: true });
    assert.deepEqual(await watch(peerWatcher, f.peerFace.id), { scopeId: f.peerFace.id, ok: true });
    // The other server's projection is not this server's conversation.
    assert.deepEqual(await watch(hostWatcher, f.peerFace.id), { scopeId: f.peerFace.id, ok: false });
    const hostFrames = collect(hostWatcher, READ_PROGRESS_UPDATED_EVENT);
    const peerFrames = collect(peerWatcher, READ_PROGRESS_UPDATED_EVENT);

    // The peer server's agent reads (its cursor is on the peer projection).
    const next = await createMessage(f.canonicalId, "user", f.hostOwnerId, "rpj-live next");
    const both = [waitEvent(hostWatcher, READ_PROGRESS_UPDATED_EVENT), waitEvent(peerWatcher, READ_PROGRESS_UPDATED_EVENT)];
    assert.equal((await markAgentLegacyRead(f.peerAgent.id, f.peerFace.id, next.seq)).changed, true);
    assert.deepEqual(await Promise.all(both), [
      { scopeId: f.hostFace.id, peers: [{ peerId: f.peerAgent.id, maxReadSeq: next.seq }] },
      { scopeId: f.peerFace.id, peers: [{ peerId: f.peerAgent.id, maxReadSeq: next.seq }] },
    ]);

    // And the host server's agent, the other way round.
    const again = await createMessage(f.canonicalId, "user", f.peerOwnerId, "rpj-live again");
    const second = [waitEvent(hostWatcher, READ_PROGRESS_UPDATED_EVENT), waitEvent(peerWatcher, READ_PROGRESS_UPDATED_EVENT)];
    await markAgentLegacyRead(f.hostAgent.id, f.hostFace.id, again.seq);
    assert.deepEqual(await Promise.all(second), [
      { scopeId: f.hostFace.id, peers: [{ peerId: f.hostAgent.id, maxReadSeq: again.seq }] },
      { scopeId: f.peerFace.id, peers: [{ peerId: f.hostAgent.id, maxReadSeq: again.seq }] },
    ]);

    // A person's read sends nothing to anyone.
    const last = await createMessage(f.canonicalId, "user", f.hostOwnerId, "rpj-live last");
    await markRead(f.peerOwnerId, f.peerFace.id, last.seq);
    await sleep(QUIET_MS);
    assert.equal(hostFrames.length, 2);
    assert.equal(peerFrames.length, 2);
  } finally {
    hostWatcher.disconnect();
    peerWatcher.disconnect();
  }
});

test("joint: the viewer's own server's flag decides; a watcher out of its projection's channel room gets nothing", async ({ app }) => {
  const f = await seedJoint("rpj-flag");
  // Only the peer server has the flag.
  await enableAgentReadProgress(f.peer.id);
  const hostWatcher = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerWatcher = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    const hostFrames = collect(hostWatcher, READ_PROGRESS_UPDATED_EVENT);
    assert.deepEqual(await watch(hostWatcher, f.hostFace.id), { scopeId: f.hostFace.id, ok: false }, "flag off for the host server");
    assert.equal(app.io.sockets.sockets.get(hostWatcher.id)!.rooms.has(readProgressRoom(f.hostFace.id)), false);
    assert.deepEqual(await watch(peerWatcher, f.peerFace.id), { scopeId: f.peerFace.id, ok: true }, "flag on for the peer server");

    // The peer side sees its own agent move.
    const next = await createMessage(f.canonicalId, "user", f.peerOwnerId, "rpj-flag next");
    const frame = waitEvent(peerWatcher, READ_PROGRESS_UPDATED_EVENT);
    await markAgentLegacyRead(f.peerAgent.id, f.peerFace.id, next.seq);
    assert.deepEqual(await frame, { scopeId: f.peerFace.id, peers: [{ peerId: f.peerAgent.id, maxReadSeq: next.seq }] });

    // Revocation (the projection disconnected, the person removed): the socket
    // leaves the projection's channel room, not the watch room.
    const peerFrames = collect(peerWatcher, READ_PROGRESS_UPDATED_EVENT);
    app.io.sockets.sockets.get(peerWatcher.id)!.leave(`channel:${f.peerFace.id}`);
    const after = await createMessage(f.canonicalId, "user", f.peerOwnerId, "rpj-flag after");
    await markAgentLegacyRead(f.peerAgent.id, f.peerFace.id, after.seq);
    await sleep(QUIET_MS);
    assert.deepEqual(peerFrames, []);
    assert.deepEqual(hostFrames, [], "the host server, flag off, never gets a frame");
  } finally {
    hostWatcher.disconnect();
    peerWatcher.disconnect();
  }
});

test("joint: a thread under a joint channel reaches both sides' watchers under each side's thread id", async ({ app }) => {
  const f = await seedJoint("rpj-thread");
  await enableAgentReadProgress(f.host.id);
  await enableAgentReadProgress(f.peer.id);
  const parent = await createMessage(f.canonicalId, "user", f.hostOwnerId, "rpj-thread parent");
  const hostThread = await getOrCreateThreadForChannel(f.hostFace.id, parent.id, f.hostOwnerId, "user");
  const faces = await getActiveJointThreadProjectionsByCanonicalThread(hostThread.canonicalThreadChannelId);
  const peerThread = faces.find((face) => face.localServerId === f.peer.id);
  assert.ok(peerThread, "the peer server has its own projection of the thread");

  const hostWatcher = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerWatcher = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    assert.equal((await watch(hostWatcher, hostThread.id)).ok, true);
    assert.equal((await watch(peerWatcher, peerThread.localThreadChannelId)).ok, true);
    const reply = await createMessage(hostThread.canonicalThreadChannelId, "user", f.hostOwnerId, "rpj-thread reply");
    const both = [waitEvent(hostWatcher, READ_PROGRESS_UPDATED_EVENT), waitEvent(peerWatcher, READ_PROGRESS_UPDATED_EVENT)];
    await markAgentLegacyRead(f.peerAgent.id, peerThread.localThreadChannelId, reply.seq);
    assert.deepEqual(await Promise.all(both), [
      { scopeId: hostThread.id, peers: [{ peerId: f.peerAgent.id, maxReadSeq: reply.seq }] },
      { scopeId: peerThread.localThreadChannelId, peers: [{ peerId: f.peerAgent.id, maxReadSeq: reply.seq }] },
    ]);
  } finally {
    hostWatcher.disconnect();
    peerWatcher.disconnect();
  }
});

test("joint: an agent's stopped follow, on its own server's projection, shows on both sides; a mention brings it back everywhere", async ({ app }) => {
  const f = await seedJoint("rpj-follow");
  const parent = await createMessage(f.canonicalId, "user", f.hostOwnerId, "rpj-follow parent");
  const hostThread = await getOrCreateThreadForChannel(f.hostFace.id, parent.id, f.hostOwnerId, "user");
  const faces = await getActiveJointThreadProjectionsByCanonicalThread(hostThread.canonicalThreadChannelId);
  const peerThreadId = faces.find((face) => face.localServerId === f.peer.id)?.localThreadChannelId;
  assert.ok(peerThreadId, "the peer server has its own projection of the thread");
  await recordThreadFollow("agent", f.hostAgent.id, hostThread.id, parent.id, "replied");
  await recordThreadFollow("agent", f.peerAgent.id, peerThreadId, parent.id, "replied");
  await unfollowThreadForFollower("agent", f.peerAgent.id, peerThreadId);

  const sides = [
    [f.hostToken, f.host.id, hostThread.id],
    [f.peerToken, f.peer.id, peerThreadId],
  ] as const;
  for (const [token, serverId, threadId] of sides) {
    const states = (await detail(app.baseUrl, token, serverId, threadId)).peerReadStates ?? [];
    assert.deepEqual(states.filter((state) => state.stoppedFollowing).map((state) => state.peerId), [f.peerAgent.id]);
    assert.equal(states.some((state) => state.peerKind === "human"), false, "a person's state never leaves the server");
    assert.deepEqual(
      Object.keys(states.find((state) => state.peerId === f.peerAgent.id)!).sort(),
      ["maxReadSeq", "peerId", "peerKind", "stoppedFollowing"],
      "only the fact: no time, no reason, no one who did it",
    );
  }

  const hostViewer = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerViewer = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    // An open thread's panel sits in the thread's own room (join:channel).
    app.io.sockets.sockets.get(hostViewer.id)!.join(`channel:${hostThread.id}`);
    app.io.sockets.sockets.get(peerViewer.id)!.join(`channel:${peerThreadId}`);
    const updates = [waitEvent(hostViewer, "thread:followers-updated"), waitEvent(peerViewer, "thread:followers-updated")];
    await recordThreadFollow("agent", f.peerAgent.id, peerThreadId, parent.id, "mentioned", {
      reactivateUnfollowed: true,
      preserveExistingReason: true,
    });
    assert.deepEqual(await Promise.all(updates), [{ threadChannelId: hostThread.id }, { threadChannelId: peerThreadId }]);
  } finally {
    hostViewer.disconnect();
    peerViewer.disconnect();
  }
  for (const [token, serverId, threadId] of sides) {
    const states = (await detail(app.baseUrl, token, serverId, threadId)).peerReadStates ?? [];
    assert.equal(states.some((state) => "stoppedFollowing" in state), false);
  }
});

/** One of the agent's own `raft` calls (the agent API, as its CLI makes it). */
async function asAgent(baseUrl: string, agentId: string, path: string, body: unknown = {}) {
  const { apiKey } = await mintAgentCredential({ agentId, scopes: ["channels"], name: `rpj-${path}`, issuedVia: "computer", createdByUserId: null });
  const response = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

test("joint: an agent's mute, on its own server's projection, shows on both sides and tells both sides' watchers; unmuting clears it everywhere", async ({ app }) => {
  const f = await seedJoint("rpj-mute");
  for (const server of [f.host, f.peer]) {
    await enableAgentReadProgress(server.id);
  }
  const sides = [
    [f.hostToken, f.host.id, f.hostFace.id],
    [f.peerToken, f.peer.id, f.peerFace.id],
  ] as const;
  const hostWatcher = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerWatcher = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    assert.equal((await watch(hostWatcher, f.hostFace.id)).ok, true);
    assert.equal((await watch(peerWatcher, f.peerFace.id)).ok, true);

    const muted = [waitEvent(hostWatcher, READ_PROGRESS_DETAIL_CHANGED_EVENT), waitEvent(peerWatcher, READ_PROGRESS_DETAIL_CHANGED_EVENT)];
    await asAgent(app.baseUrl, f.peerAgent.id, `/channels/${f.peerFace.id}/mute`);
    assert.deepEqual(await Promise.all(muted), [{ scopeId: f.hostFace.id }, { scopeId: f.peerFace.id }], "each side under its own id");
    for (const [token, serverId, channelId] of sides) {
      const states = (await detail(app.baseUrl, token, serverId, channelId)).peerReadStates ?? [];
      assert.deepEqual(states.filter((state) => state.mutedChannel).map((state) => state.peerId), [f.peerAgent.id]);
      assert.equal(states.some((state) => state.peerKind === "human"), false, "a person's state never leaves the server");
      assert.deepEqual(
        Object.keys(states.find((state) => state.peerId === f.peerAgent.id)!).sort(),
        ["maxReadSeq", "mutedChannel", "peerId", "peerKind"],
        "only the fact: not since when",
      );
    }

    const unmuted = [waitEvent(hostWatcher, READ_PROGRESS_DETAIL_CHANGED_EVENT), waitEvent(peerWatcher, READ_PROGRESS_DETAIL_CHANGED_EVENT)];
    await asAgent(app.baseUrl, f.peerAgent.id, `/channels/${f.peerFace.id}/unmute`);
    assert.deepEqual(await Promise.all(unmuted), [{ scopeId: f.hostFace.id }, { scopeId: f.peerFace.id }]);
  } finally {
    hostWatcher.disconnect();
    peerWatcher.disconnect();
  }
  for (const [token, serverId, channelId] of sides) {
    const states = (await detail(app.baseUrl, token, serverId, channelId)).peerReadStates ?? [];
    assert.equal(states.some((state) => "mutedChannel" in state), false);
  }
});

test("joint: an agent's own unfollow of a joint thread tells both sides' open threads, as its follow coming back does", async ({ app }) => {
  const f = await seedJoint("rpj-unfollow");
  const parent = await createMessage(f.canonicalId, "user", f.hostOwnerId, "rpj-unfollow parent");
  const hostThread = await getOrCreateThreadForChannel(f.hostFace.id, parent.id, f.hostOwnerId, "user");
  const faces = await getActiveJointThreadProjectionsByCanonicalThread(hostThread.canonicalThreadChannelId);
  const peerThreadId = faces.find((face) => face.localServerId === f.peer.id)?.localThreadChannelId;
  assert.ok(peerThreadId, "the peer server has its own projection of the thread");
  await recordThreadFollow("agent", f.peerAgent.id, peerThreadId, parent.id, "replied");

  const hostViewer = await connect(app.baseUrl, f.hostToken, f.host.id);
  const peerViewer = await connect(app.baseUrl, f.peerToken, f.peer.id);
  try {
    // An open thread's panel sits in the thread's own room (join:channel).
    app.io.sockets.sockets.get(hostViewer.id)!.join(`channel:${hostThread.id}`);
    app.io.sockets.sockets.get(peerViewer.id)!.join(`channel:${peerThreadId}`);
    const updates = [waitEvent(hostViewer, "thread:followers-updated"), waitEvent(peerViewer, "thread:followers-updated")];
    await asAgent(app.baseUrl, f.peerAgent.id, "/threads/unfollow", { thread: peerThreadId });
    assert.deepEqual(await Promise.all(updates), [{ threadChannelId: hostThread.id }, { threadChannelId: peerThreadId }]);
  } finally {
    hostViewer.disconnect();
    peerViewer.disconnect();
  }
  for (const [token, serverId, threadId] of [
    [f.hostToken, f.host.id, hostThread.id],
    [f.peerToken, f.peer.id, peerThreadId],
  ] as const) {
    const states = (await detail(app.baseUrl, token, serverId, threadId)).peerReadStates ?? [];
    assert.deepEqual(states.filter((state) => state.stoppedFollowing).map((state) => state.peerId), [f.peerAgent.id]);
  }
});
