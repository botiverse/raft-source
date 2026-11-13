/**
 * Agent read progress over a real socket (agentReadProgressService.ts, flag
 * `agent_read_progress_v0`): the flag gates watching and pushing; a watching
 * socket gets one coalesced `read_progress:updated` per burst of advances, only
 * for moves past a shown message; a socket that did not watch (yet sits in the
 * channel room) gets nothing; a person who cannot open the conversation, and
 * #all, cannot be watched. The detail says which agents a message will not
 * reach (stopped following a thread, muted a channel), and a change to that
 * tells the open conversation to load it again.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import {
  AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
  READ_PROGRESS_DETAIL_CHANGED_EVENT,
  READ_PROGRESS_UPDATED_EVENT,
  READ_PROGRESS_WATCH_EVENT,
  READ_PROGRESS_WATCHED_EVENT,
  readProgressRoom,
  type ReadProgressUpdatedPayload,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentChannelReadCursors, channels, featureFlagRules, messages } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { revealAllChannelForTest } from "../test/allChannelFixture";
import { addMember } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import {
  addAgent,
  addHuman,
  createChannel,
  getActivityMutedAgentIdsForMessage,
  getOrCreateThread,
  markAgentLegacyAckCheckpoint,
  markAgentLegacyRead,
  markAgentOwnSendRead,
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
  // The flag row itself is seeded by migration 0576 (default off, no rules).
  await getDb().insert(featureFlagRules).values({
    flagKey: AGENT_READ_PROGRESS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

/** A private channel with its owner, a second member and one agent, and two messages the agent has read. */
async function seedConversation(label: string) {
  __resetAgentReadProgressForTests();
  const owner = await seedUser(`${label}-owner-${randomUUID().slice(0, 6)}@slock.test`, `${label}-owner`);
  const member = await seedUser(`${label}-member-${randomUUID().slice(0, 6)}@slock.test`, `${label}-member`);
  const outsider = await seedUser(`${label}-outsider-${randomUUID().slice(0, 6)}@slock.test`, `${label}-outsider`);
  const server = await createServer(`${label} server`, `${label}-${randomUUID().slice(0, 8)}`, owner.id);
  await addMember(server.id, member.id);
  await addMember(server.id, outsider.id);
  const channel = await createChannel(server.id, `${label}-channel`, undefined, "private");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  const agent = await createAgent(server.id, `${label}-agent`);
  await addAgent(channel.id, agent.id);
  const seen = await createMessage(channel.id, "user", owner.id, `${label} already read`);
  await getDb().insert(agentChannelReadCursors).values({ agentId: agent.id, channelId: channel.id, lastReadSeq: seen.seq })
    .onConflictDoUpdate({
      target: [agentChannelReadCursors.agentId, agentChannelReadCursors.channelId],
      set: { lastReadSeq: seen.seq },
    });
  return {
    server,
    channel,
    agent,
    seen,
    ownerId: owner.id,
    ownerToken: await tokenForHuman(owner.email),
    memberToken: await tokenForHuman(member.email),
    outsiderToken: await tokenForHuman(outsider.email),
  };
}

test("flag off: a watch is refused and an agent's advance sends no frame", async ({ app }) => {
  const f = await seedConversation("rp-off");
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    const frames = collect(socket, READ_PROGRESS_UPDATED_EVENT);
    assert.deepEqual(await watch(socket, f.channel.id), { scopeId: f.channel.id, ok: false });
    const serverSocket = app.io.sockets.sockets.get(socket.id)!;
    assert.equal(serverSocket.rooms.has(readProgressRoom(f.channel.id)), false);

    const next = await createMessage(f.channel.id, "user", f.ownerId, "rp-off next");
    await markAgentLegacyAckCheckpoint(f.agent.id, [next.seq]);
    await sleep(QUIET_MS);
    assert.deepEqual(frames, [], "no frame while the flag is off");
  } finally { socket.disconnect(); }
});

test("flag on: two quick advances reach a watching socket as one frame; a socket that did not watch gets nothing", async ({ app }) => {
  const f = await seedConversation("rp-on");
  await enableAgentReadProgress(f.server.id);
  const watcher = await connect(app.baseUrl, f.ownerToken, f.server.id);
  const bystander = await connect(app.baseUrl, f.memberToken, f.server.id);
  try {
    const watcherFrames = collect(watcher, READ_PROGRESS_UPDATED_EVENT);
    const bystanderFrames = collect(bystander, READ_PROGRESS_UPDATED_EVENT);
    assert.equal(
      app.io.sockets.sockets.get(bystander.id)!.rooms.has(`channel:${f.channel.id}`),
      true,
      "the bystander sits in the channel room: frames must not go there",
    );
    assert.deepEqual(await watch(watcher, f.channel.id), { scopeId: f.channel.id, ok: true });
    assert.equal(app.io.sockets.sockets.get(watcher.id)!.rooms.has(readProgressRoom(f.channel.id)), true);

    const ownerId = f.ownerId;
    const first = await createMessage(f.channel.id, "user", ownerId, "rp-on first");
    const second = await createMessage(f.channel.id, "user", ownerId, "rp-on second");
    const frame = waitEvent(watcher, READ_PROGRESS_UPDATED_EVENT);
    // A history read (sequencer) and a `raft message check` ack, in one burst.
    await markRead({ kind: "agent", id: f.agent.id }, f.channel.id, first.seq);
    await markAgentLegacyAckCheckpoint(f.agent.id, [second.seq]);
    const expected: ReadProgressUpdatedPayload = {
      scopeId: f.channel.id,
      peers: [{ peerId: f.agent.id, maxReadSeq: second.seq }],
    };
    assert.deepEqual(await frame, expected);
    await sleep(QUIET_MS);
    assert.deepEqual(watcherFrames, [expected], "one frame for the burst");
    assert.deepEqual(bystanderFrames, [], "a socket that did not watch gets nothing");

    // An agent's own send moves it onto its own message (the send pipeline's
    // sender read, broadcastAndDeliver, is markAgentOwnSendRead).
    const own = waitEvent(watcher, READ_PROGRESS_UPDATED_EVENT);
    const sent = await createMessage(f.channel.id, "agent", f.agent.id, "rp-on own send");
    assert.equal((await markAgentOwnSendRead(f.agent.id, f.channel.id, sent.seq)).changed, true);
    assert.deepEqual(await own, { scopeId: f.channel.id, peers: [{ peerId: f.agent.id, maxReadSeq: sent.seq }] });
  } finally {
    watcher.disconnect();
    bystander.disconnect();
  }
});

test("flag on: an advance past no shown message sends no frame", async ({ app }) => {
  const f = await seedConversation("rp-hidden");
  await enableAgentReadProgress(f.server.id);
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    const frames = collect(socket, READ_PROGRESS_UPDATED_EVENT);
    assert.equal((await watch(socket, f.channel.id)).ok, true);
    const ownerId = f.ownerId;
    const retracted = await createMessage(f.channel.id, "user", ownerId, "rp-hidden retracted");
    await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, retracted.id));

    const moved = await markAgentLegacyRead(f.agent.id, f.channel.id, retracted.seq);
    assert.equal(moved.changed, true, "the cursor did move");
    await sleep(QUIET_MS);
    assert.deepEqual(frames, [], "passing only a retracted message is not progress the web can show");

    // The same socket still gets a move past a shown message.
    const shown = await createMessage(f.channel.id, "user", ownerId, "rp-hidden shown");
    const frame = waitEvent(socket, READ_PROGRESS_UPDATED_EVENT);
    await markAgentLegacyRead(f.agent.id, f.channel.id, shown.seq);
    assert.deepEqual(await frame, { scopeId: f.channel.id, peers: [{ peerId: f.agent.id, maxReadSeq: shown.seq }] });
  } finally { socket.disconnect(); }
});

test("flag on: a watcher taken out of the conversation's channel room gets no more frames", async ({ app }) => {
  const f = await seedConversation("rp-revoked");
  await enableAgentReadProgress(f.server.id);
  const kept = await connect(app.baseUrl, f.ownerToken, f.server.id);
  const revoked = await connect(app.baseUrl, f.memberToken, f.server.id);
  try {
    const revokedFrames = collect(revoked, READ_PROGRESS_UPDATED_EVENT);
    assert.equal((await watch(kept, f.channel.id)).ok, true);
    assert.equal((await watch(revoked, f.channel.id)).ok, true);

    // What every revocation site does (removed from the channel, made private,
    // left the server, ...): the socket leaves `channel:<id>`, not the watch room.
    app.io.sockets.sockets.get(revoked.id)!.leave(`channel:${f.channel.id}`);
    assert.equal(app.io.sockets.sockets.get(revoked.id)!.rooms.has(readProgressRoom(f.channel.id)), true);

    const next = await createMessage(f.channel.id, "user", f.ownerId, "rp-revoked next");
    const frame = waitEvent(kept, READ_PROGRESS_UPDATED_EVENT);
    await markAgentLegacyAckCheckpoint(f.agent.id, [next.seq]);
    assert.deepEqual(await frame, { scopeId: f.channel.id, peers: [{ peerId: f.agent.id, maxReadSeq: next.seq }] });
    await sleep(QUIET_MS);
    assert.deepEqual(revokedFrames, [], "a watcher no longer allowed to see the conversation gets nothing");
  } finally {
    kept.disconnect();
    revoked.disconnect();
  }
});

test("flag on: a thread under a private channel reaches its watchers through the parent's room, and stops when they leave it", async ({ app }) => {
  const f = await seedConversation("rp-thread");
  await enableAgentReadProgress(f.server.id);
  const parent = await createMessage(f.channel.id, "user", f.ownerId, "rp-thread parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  const kept = await connect(app.baseUrl, f.ownerToken, f.server.id);
  const revoked = await connect(app.baseUrl, f.memberToken, f.server.id);
  try {
    const revokedFrames = collect(revoked, READ_PROGRESS_UPDATED_EVENT);
    assert.equal((await watch(kept, thread.id)).ok, true);
    assert.equal((await watch(revoked, thread.id)).ok, true);
    for (const socket of [kept, revoked]) {
      const rooms = app.io.sockets.sockets.get(socket.id)!.rooms;
      assert.equal(rooms.has(`channel:${thread.id}`), false, "watching a thread does not need its own channel room");
      assert.equal(rooms.has(`channel:${f.channel.id}`), true);
    }

    const first = await createMessage(thread.id, "user", f.ownerId, "rp-thread first reply");
    const both = [waitEvent(kept, READ_PROGRESS_UPDATED_EVENT), waitEvent(revoked, READ_PROGRESS_UPDATED_EVENT)];
    await markAgentLegacyRead(f.agent.id, thread.id, first.seq);
    const expectedFirst = { scopeId: thread.id, peers: [{ peerId: f.agent.id, maxReadSeq: first.seq }] };
    assert.deepEqual(await Promise.all(both), [expectedFirst, expectedFirst]);

    // Revocation leaves the parent's room (removed from the channel, ...).
    app.io.sockets.sockets.get(revoked.id)!.leave(`channel:${f.channel.id}`);
    const second = await createMessage(thread.id, "user", f.ownerId, "rp-thread second reply");
    const frame = waitEvent(kept, READ_PROGRESS_UPDATED_EVENT);
    await markAgentLegacyRead(f.agent.id, thread.id, second.seq);
    assert.deepEqual(await frame, { scopeId: thread.id, peers: [{ peerId: f.agent.id, maxReadSeq: second.seq }] });
    await sleep(QUIET_MS);
    assert.deepEqual(revokedFrames, [expectedFirst], "nothing after leaving the parent channel's room");
  } finally {
    kept.disconnect();
    revoked.disconnect();
  }
});

test("flag on: a person who cannot open the conversation cannot watch it", async ({ app }) => {
  const f = await seedConversation("rp-access");
  await enableAgentReadProgress(f.server.id);
  const socket = await connect(app.baseUrl, f.outsiderToken, f.server.id);
  try {
    const frames = collect(socket, READ_PROGRESS_UPDATED_EVENT);
    assert.deepEqual(await watch(socket, f.channel.id), { scopeId: f.channel.id, ok: false }, "not a member of the private channel");
    const missing = randomUUID();
    assert.deepEqual(await watch(socket, missing), { scopeId: missing, ok: false }, "no such conversation");
    assert.deepEqual(await watch(socket, "not-a-uuid"), { scopeId: "not-a-uuid", ok: false }, "malformed id fails closed");
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(readProgressRoom(f.channel.id)), false);

    const next = await createMessage(f.channel.id, "user", f.ownerId, "rp-access next");
    await markAgentLegacyRead(f.agent.id, f.channel.id, next.seq);
    await sleep(QUIET_MS);
    assert.deepEqual(frames, []);
  } finally { socket.disconnect(); }
});

test("flag on: #all carries no read progress and cannot be watched", async ({ app }) => {
  const f = await seedConversation("rp-all");
  await enableAgentReadProgress(f.server.id);
  await revealAllChannelForTest(f.server.id);
  const [all] = await getDb().select().from(channels)
    .where(and(eq(channels.serverId, f.server.id), eq(channels.name, "all")));
  assert.ok(all);
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(`channel:${all.id}`), true, "the owner can open #all");
    assert.deepEqual(await watch(socket, all.id), { scopeId: all.id, ok: false });
    assert.equal(app.io.sockets.sockets.get(socket.id)!.rooms.has(readProgressRoom(all.id)), false);
  } finally { socket.disconnect(); }
});

type PeerState = { peerId: string; stoppedFollowing?: boolean; mutedChannel?: boolean };

async function peerStates(baseUrl: string, token: string, serverId: string, channelId: string): Promise<PeerState[]> {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}`, { headers: headers(token, serverId) });
  assert.equal(response.status, 200, await response.clone().text());
  return ((await response.json()) as { peerReadStates?: PeerState[] }).peerReadStates ?? [];
}

test("stopped following: only an agent with an unfollowed row in a thread is marked; following again clears it", async ({ app }) => {
  const f = await seedConversation("rp-follow");
  const never = await createAgent(f.server.id, "rp-follow-never");
  await addAgent(f.channel.id, never.id);
  const parent = await createMessage(f.channel.id, "user", f.ownerId, "rp-follow parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "replied");
  const stoppedIn = async (channelId: string) => (await peerStates(app.baseUrl, f.ownerToken, f.server.id, channelId))
    .filter((state) => state.stoppedFollowing)
    .map((state) => state.peerId);

  assert.deepEqual(await stoppedIn(thread.id), [], "following, or never followed: not stopped");

  await unfollowThreadForFollower("agent", f.agent.id, thread.id);
  assert.deepEqual(await stoppedIn(thread.id), [f.agent.id]);
  assert.deepEqual(await stoppedIn(f.channel.id), [], "a channel has no follows, whatever its threads say");

  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    app.io.sockets.sockets.get(socket.id)!.join(`channel:${thread.id}`);
    const update = waitEvent(socket, "thread:followers-updated");
    await recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "mentioned", {
      reactivateUnfollowed: true,
      preserveExistingReason: true,
    });
    assert.deepEqual(await update, { threadChannelId: thread.id }, "a reactivated follow tells open threads");
    assert.deepEqual(await stoppedIn(thread.id), []);

    // An ordinary auto-follow does not override the unfollow, so nothing changed and nothing is said.
    await unfollowThreadForFollower("agent", f.agent.id, thread.id);
    const updates = collect(socket, "thread:followers-updated");
    await recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "authored");
    await recordThreadFollow("agent", never.id, thread.id, parent.id, "mentioned");
    await sleep(QUIET_MS);
    assert.deepEqual(updates, [], "no reactivation, no event");
    assert.deepEqual(await stoppedIn(thread.id), [f.agent.id]);
  } finally { socket.disconnect(); }
});

test("stopped following: a reactivation in a caller's transaction sends no event, which would beat its commit", async ({ app }) => {
  const f = await seedConversation("rp-follow-tx");
  const parent = await createMessage(f.channel.id, "user", f.ownerId, "rp-follow-tx parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "replied");
  await unfollowThreadForFollower("agent", f.agent.id, thread.id);

  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    app.io.sockets.sockets.get(socket.id)!.join(`channel:${thread.id}`);
    const updates = collect(socket, "thread:followers-updated");
    await getDb().transaction((tx) => recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "mentioned", {
      reactivateUnfollowed: true,
      preserveExistingReason: true,
      executor: tx,
    }));
    await sleep(QUIET_MS);
    assert.deepEqual(updates, []);
    const states = await peerStates(app.baseUrl, f.ownerToken, f.server.id, thread.id);
    assert.equal(states.some((state) => state.stoppedFollowing), false, "the follow itself did come back");
  } finally { socket.disconnect(); }
});

/** The agent's own `raft channel mute` / `unmute` (the agent API, as its CLI calls it). */
async function agentChannelAttention(baseUrl: string, agentId: string, channelId: string, action: "mute" | "unmute") {
  const { apiKey } = await mintAgentCredential({ agentId, scopes: ["channels"], name: `rp-${action}`, issuedVia: "computer", createdByUserId: null });
  const response = await fetch(`${baseUrl}/internal/agent-api/channels/${channelId}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200, await response.clone().text());
}

test("muted: only an agent whose own mute of the channel stands is marked, in the channel and not its threads; unmuting clears it", async ({ app }) => {
  const f = await seedConversation("rp-mute");
  const other = await createAgent(f.server.id, "rp-mute-other");
  await addAgent(f.channel.id, other.id);
  const parent = await createMessage(f.channel.id, "user", f.ownerId, "rp-mute parent");
  const thread = await getOrCreateThread(parent.id, f.ownerId, "user");
  await recordThreadFollow("agent", f.agent.id, thread.id, parent.id, "replied");
  const mutedIn = async (channelId: string) => (await peerStates(app.baseUrl, f.ownerToken, f.server.id, channelId))
    .filter((state) => state.mutedChannel)
    .map((state) => state.peerId);

  assert.deepEqual(await mutedIn(f.channel.id), [], "no agent muted it");

  await agentChannelAttention(app.baseUrl, f.agent.id, f.channel.id, "mute");
  assert.deepEqual(await mutedIn(f.channel.id), [f.agent.id]);
  const later = await createMessage(f.channel.id, "user", f.ownerId, "rp-mute after the mute");
  assert.deepEqual(
    [...await getActivityMutedAgentIdsForMessage({
      serverId: f.server.id,
      sourceChannelId: f.channel.id,
      agentIds: [f.agent.id, other.id],
      messageSeq: later.seq,
    })],
    [f.agent.id],
    "the same agents delivery leaves an ordinary message out for",
  );
  const states = await peerStates(app.baseUrl, f.ownerToken, f.server.id, f.channel.id);
  assert.deepEqual(
    Object.keys(states.find((state) => state.peerId === f.agent.id)!).sort(),
    ["maxReadSeq", "mutedChannel", "peerId", "peerKind"],
    "only the fact: not since when",
  );
  assert.deepEqual(await mutedIn(thread.id), [], "a thread it follows still reaches it: the parent's mute is not the thread's");
  assert.equal(
    (await peerStates(app.baseUrl, f.ownerToken, f.server.id, thread.id)).some((state) => "mutedChannel" in state),
    false,
  );

  await agentChannelAttention(app.baseUrl, f.agent.id, f.channel.id, "unmute");
  assert.equal(
    (await peerStates(app.baseUrl, f.ownerToken, f.server.id, f.channel.id)).some((state) => "mutedChannel" in state),
    false,
    "unmuted: absent again",
  );
});

test("muted: an agent's mute and unmute tell the channel's watchers to load the detail again, and no one else; a mute that changes nothing says nothing", async ({ app }) => {
  const f = await seedConversation("rp-mute-event");
  await enableAgentReadProgress(f.server.id);
  const watcher = await connect(app.baseUrl, f.ownerToken, f.server.id);
  // In the channel's room (a member), but not watching it.
  const bystander = await connect(app.baseUrl, f.memberToken, f.server.id);
  try {
    assert.deepEqual(await watch(watcher, f.channel.id), { scopeId: f.channel.id, ok: true });
    assert.equal(app.io.sockets.sockets.get(bystander.id)!.rooms.has(`channel:${f.channel.id}`), true, "precondition");
    const heard = collect(bystander, READ_PROGRESS_DETAIL_CHANGED_EVENT);

    const muted = waitEvent(watcher, READ_PROGRESS_DETAIL_CHANGED_EVENT);
    await agentChannelAttention(app.baseUrl, f.agent.id, f.channel.id, "mute");
    assert.deepEqual(await muted, { scopeId: f.channel.id });

    const repeated = collect(watcher, READ_PROGRESS_DETAIL_CHANGED_EVENT);
    await agentChannelAttention(app.baseUrl, f.agent.id, f.channel.id, "mute");
    await sleep(QUIET_MS);
    assert.deepEqual(repeated, [], "already muted: nothing changed, nothing is said");

    const unmuted = waitEvent(watcher, READ_PROGRESS_DETAIL_CHANGED_EVENT);
    await agentChannelAttention(app.baseUrl, f.agent.id, f.channel.id, "unmute");
    assert.deepEqual(await unmuted, { scopeId: f.channel.id });
    await sleep(QUIET_MS);
    assert.deepEqual(heard, [], "a socket that does not watch the channel is not told");
  } finally {
    watcher.disconnect();
    bystander.disconnect();
  }
});
