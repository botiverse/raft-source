/**
 * An agent's follow of a thread coming back (recordThreadFollow reactivating
 * an unfollowed row) tells the thread's open views over a real socket:
 * `thread:followers-updated` (threadFollowerRealtimeService
 * noteAgentThreadFollowResumed), so their follower list loads again. Nothing
 * is said when nothing came back, nor from inside a caller's transaction
 * (the event would beat its commit).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getDb } from "../db/index";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { createAgent } from "../services/agentService";
import {
  addAgent,
  addHuman,
  createChannel,
  getOrCreateThread,
  recordThreadFollow,
  unfollowThreadForFollower,
} from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createServer, seedUser } from "./channels.api.fixtures";

const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest();

// Long enough that an event that was going to come has come.
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

/** A private channel with its owner and one agent, and a thread the agent followed and then stopped following. */
async function seedThread(label: string) {
  const owner = await seedUser(`${label}-owner-${randomUUID().slice(0, 6)}@slock.test`, `${label}-owner`);
  const server = await createServer(`${label} server`, `${label}-${randomUUID().slice(0, 8)}`, owner.id);
  const channel = await createChannel(server.id, `${label}-channel`, undefined, "private");
  await addHuman(channel.id, owner.id);
  const agent = await createAgent(server.id, `${label}-agent`);
  await addAgent(channel.id, agent.id);
  const parent = await createMessage(channel.id, "user", owner.id, `${label} parent`);
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  await recordThreadFollow("agent", agent.id, thread.id, parent.id, "replied");
  await unfollowThreadForFollower("agent", agent.id, thread.id);
  return { server, agent, parent, thread, ownerToken: await tokenForHuman(owner.email) };
}

test("an agent's follow coming back tells the thread's open views; an auto-follow that does not override the unfollow says nothing", async ({ app }) => {
  const f = await seedThread("tfr");
  const never = await createAgent(f.server.id, "tfr-never");
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    app.io.sockets.sockets.get(socket.id)!.join(`channel:${f.thread.id}`);
    const update = waitEvent(socket, "thread:followers-updated");
    await recordThreadFollow("agent", f.agent.id, f.thread.id, f.parent.id, "mentioned", {
      reactivateUnfollowed: true,
      preserveExistingReason: true,
    });
    assert.deepEqual(await update, { threadChannelId: f.thread.id });

    await unfollowThreadForFollower("agent", f.agent.id, f.thread.id);
    const updates = collect(socket, "thread:followers-updated");
    await recordThreadFollow("agent", f.agent.id, f.thread.id, f.parent.id, "authored");
    await recordThreadFollow("agent", never.id, f.thread.id, f.parent.id, "mentioned");
    await sleep(QUIET_MS);
    assert.deepEqual(updates, [], "no reactivation, no event");
  } finally { socket.disconnect(); }
});

test("a reactivation in a caller's transaction sends no event, which would beat its commit", async ({ app }) => {
  const f = await seedThread("tfr-tx");
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    app.io.sockets.sockets.get(socket.id)!.join(`channel:${f.thread.id}`);
    const updates = collect(socket, "thread:followers-updated");
    await getDb().transaction((tx) => recordThreadFollow("agent", f.agent.id, f.thread.id, f.parent.id, "mentioned", {
      reactivateUnfollowed: true,
      preserveExistingReason: true,
      executor: tx,
    }));
    await sleep(QUIET_MS);
    assert.deepEqual(updates, []);
  } finally { socket.disconnect(); }
});

test("older clients' read_progress:watch and unwatch are accepted and ignored: no answer, the socket stays up", async ({ app }) => {
  const f = await seedThread("tfr-legacy");
  const socket = await connect(app.baseUrl, f.ownerToken, f.server.id);
  try {
    const answers = collect(socket, "read_progress:watched");
    socket.emit("read_progress:watch", { scopeId: f.thread.id });
    socket.emit("read_progress:unwatch", { scopeId: f.thread.id });
    await sleep(QUIET_MS);
    assert.deepEqual(answers, []);
    assert.equal(socket.connected, true);
  } finally { socket.disconnect(); }
});
