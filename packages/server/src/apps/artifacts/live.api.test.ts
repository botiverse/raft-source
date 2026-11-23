// An open Artifact page kept up to date (live.ts, core's socket/objectWatch.ts):
// `object:watch` joins a real socket to the Artifact's rooms only when its
// person reads the Artifact now, and the real write paths ping those rooms
// after their commit, and nobody else.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  artifactLinkId,
  artifactWebPaths,
  asArtifactId,
  OBJECT_CHANGED_EVENT,
  OBJECT_UNWATCH_EVENT,
  OBJECT_WATCH_EVENT,
  objectWatchRoom,
  SOCKET_NOT_SERVER_MEMBER_ERROR,
  type ObjectChangedEvent,
  type ObjectWatchAck,
} from "@botiverse/raft-shared";
import { accessTokenForTest } from "../../test/integration/credentials";
import { createAgent } from "../../services/agentService";
import { AGENT_API_KEY_HMAC_SECRET_ENV, mintAgentCredential } from "../../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../../services/channelService";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "../../services/featureFlagService";
import { createApiTest } from "../../test/integration/apiTest";
import type { createSeed } from "../../test/integration/seed";
import { __answerFlagForTests } from "../../services/deploymentAnsweredFlags";
import { __setArtifactR2StoreForTests, type ArtifactR2Store } from "./blobStore";

const requireWeb = createRequire(new URL("../../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client");
const test = createApiTest();

beforeEach(() => {
  vi.stubEnv(AGENT_API_KEY_HMAC_SECRET_ENV, "artifact-live-tests-hmac-secret-0123456789");
});
afterEach(() => {
  vi.unstubAllEnvs();
  __setArtifactR2StoreForTests(undefined);
});

const label = () => randomUUID().slice(0, 8);

function memoryR2(): ArtifactR2Store {
  const objects = new Map<string, Buffer>();
  return {
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
    async read() { return null; },
    async presign() { return null; },
  };
}

type Who = { userId: string; token: string; serverId: string };

async function call(app: { baseUrl: string }, method: string, path: string, who: Who, body?: unknown) {
  const res = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${who.token}`, "X-Server-Id": who.serverId, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

async function agentCall(app: { baseUrl: string }, method: string, path: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

/**
 * A server with private #room (owner, reader, agent A) whose Artifact `page`
 * agent A published; `other` is a member of the server, not of #room, so
 * can't see it.
 */
async function seedWorld(seed: ReturnType<typeof createSeed>, app: { baseUrl: string }) {
  const owner = await seed.human();
  const reader = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner, members: [reader, other] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const agentA = await createAgent(server.id, `live-a-${label()}`, { runtime: "claude", model: "sonnet" });
  const room = await createChannel(server.id, `room-${label()}`, undefined, "private");
  for (const human of [owner, reader]) await addHuman(room.id, human.id);
  await addAgent(room.id, agentA.id);
  __setArtifactR2StoreForTests(memoryR2());
  const keyA = (await mintAgentCredential({ agentId: agentA.id, scopes: ["read", "send"], name: `live-${label()}`, issuedVia: "computer", createdByUserId: null })).apiKey;
  const created = await agentCall(app, "POST", "/artifacts/push", keyA, { target: `#${room.name}`, title: "Plan", files: [{ path: "index.md", content: "# plan v1" }] });
  assert.equal(created.status, 201, created.text);
  const page = asArtifactId(created.body.artifact.id as string);
  const as = async (userId: string): Promise<Who> => ({ userId, token: await accessTokenForTest(userId), serverId: server.id });
  return { server, room, keyA, page, who: { owner: await as(owner.id), reader: await as(reader.id), other: await as(other.id) } };
}

const waitEvent = <T>(socket: any, event: string, timeoutMs = 4_000) => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`no ${event}`)), timeoutMs);
  socket.once(event, (value: T) => { clearTimeout(timer); resolve(value); });
});

/** A connected socket of `who`'s, its rooms set up. */
async function connect(app: { baseUrl: string }, who: Who) {
  const socket = clientIo(app.baseUrl, { auth: { token: who.token, serverId: who.serverId }, transports: ["websocket"], autoConnect: false });
  const ready = waitEvent(socket, "rooms:joined");
  socket.connect();
  await ready;
  return socket;
}

const watch = (socket: any, id: string) => new Promise<ObjectWatchAck>((resolve) => socket.emit(OBJECT_WATCH_EVENT, { kind: "artifact", id }, resolve));
const roomsOf = (app: { io: any }, socket: any): Set<string> => app.io.sockets.sockets.get(socket.id)!.rooms;

test("object:watch joins nothing for a person who can't see the Artifact, and only that Artifact's rooms for one who can", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const outsider = await connect(app, world.who.other);
  const reader = await connect(app, world.who.reader);
  try {
    assert.deepEqual(await watch(outsider, world.page), { ok: false, code: "not_visible" });
    assert.ok(![...roomsOf(app, outsider)].some((room) => room.startsWith("object-watch:")), "no room joined");

    assert.deepEqual(await watch(reader, world.page), { ok: true, id: world.page, parts: ["comments", "version"] });
    assert.ok(roomsOf(app, reader).has(objectWatchRoom("artifact", world.page, "comments")));
    assert.ok(roomsOf(app, reader).has(objectWatchRoom("artifact", world.page, "version")));
    // The short id (links' form) names the same Artifact: the ack answers its own id.
    assert.deepEqual(await watch(reader, artifactLinkId(world.page)), { ok: true, id: world.page, parts: ["comments", "version"] });
    // Malformed, an unknown kind and an id that names nothing: refused alike, nothing joined.
    assert.deepEqual(await new Promise((resolve) => outsider.emit(OBJECT_WATCH_EVENT, { kind: "artifact" }, resolve)), { ok: false, code: "invalid" });
    assert.deepEqual(await new Promise((resolve) => outsider.emit(OBJECT_WATCH_EVENT, { kind: "nope", id: world.page }, resolve)), { ok: false, code: "not_visible" });
    assert.deepEqual(await watch(outsider, `pt_${randomUUID()}`), { ok: false, code: "not_visible" });
    assert.ok(![...roomsOf(app, outsider)].some((room) => room.startsWith("object-watch:")));
  } finally {
    outsider.disconnect();
    reader.disconnect();
  }
});

test("a comment's commit pings the Artifact's watchers with object:changed, never a socket that was refused; unwatch stops it", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const outsider = await connect(app, world.who.other);
  const reader = await connect(app, world.who.reader);
  try {
    assert.equal((await watch(outsider, world.page)).ok, false);
    assert.equal((await watch(reader, world.page)).ok, true);

    const outsiderHeard = assert.rejects(waitEvent(outsider, OBJECT_CHANGED_EVENT, 1_000), /no object:changed/);
    const pinged = waitEvent<ObjectChangedEvent>(reader, OBJECT_CHANGED_EVENT);
    const posted = await call(app, "POST", artifactWebPaths.comments(world.page), world.who.owner, { body: [{ type: "text", text: "looks good" }], version: 1, target: { scope: "artifact" }, replyTo: null });
    assert.equal(posted.status, 201, posted.text);
    // Content-free: which Artifact and which part, nothing of the comment.
    assert.deepEqual(await pinged, { kind: "artifact", id: world.page, part: "comments" });
    await outsiderHeard;

    // An agent's comment (the agent API's path) pings too. Read first: a comment on the whole Artifact is held for others' unseen ones.
    assert.equal((await agentCall(app, "GET", `/artifacts/${world.page}/comments`, world.keyA)).status, 200);
    const agentPinged = waitEvent<ObjectChangedEvent>(reader, OBJECT_CHANGED_EVENT);
    const said = await agentCall(app, "POST", `/artifacts/${world.page}/comments`, world.keyA, { body: "noted" });
    assert.equal(said.status, 201, said.text);
    assert.deepEqual(await agentPinged, { kind: "artifact", id: world.page, part: "comments" });

    // A new version: `version` (read first, as the hold asks).
    assert.equal((await agentCall(app, "GET", `/artifacts/${world.page}/comments`, world.keyA)).status, 200);
    const versioned = waitEvent<ObjectChangedEvent>(reader, OBJECT_CHANGED_EVENT);
    const pushed = await agentCall(app, "POST", "/artifacts/push", world.keyA, { artifact: world.page, base: 1, files: [{ path: "index.md", content: "# plan v2" }] });
    assert.equal(pushed.status, 201, pushed.text);
    assert.deepEqual(await versioned, { kind: "artifact", id: world.page, part: "version" });

    // Unwatched: nothing more.
    reader.emit(OBJECT_UNWATCH_EVENT, { kind: "artifact", id: world.page });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(![...roomsOf(app, reader)].some((room) => room.startsWith("object-watch:")), "unwatch leaves the rooms");
    const silent = assert.rejects(waitEvent(reader, OBJECT_CHANGED_EVENT, 1_000), /no object:changed/);
    assert.equal((await call(app, "POST", artifactWebPaths.comments(world.page), world.who.owner, { body: [{ type: "text", text: "again" }], version: 1, target: { scope: "artifact" }, replyTo: null })).status, 201);
    await silent;
  } finally {
    outsider.disconnect();
    reader.disconnect();
  }
});

test("deleting the Artifact takes every socket out of its rooms", async ({ app, seed }) => {
  const world = await seedWorld(seed, app);
  const reader = await connect(app, world.who.reader);
  try {
    assert.equal((await watch(reader, world.page)).ok, true);
    const deleted = await call(app, "DELETE", artifactWebPaths.artifact(world.page), world.who.owner);
    assert.equal(deleted.status, 204, deleted.text);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(![...roomsOf(app, reader)].some((room) => room.startsWith("object-watch:")));
    // And watching it again is refused: it can't be read.
    assert.deepEqual(await watch(reader, world.page), { ok: false, code: "not_visible" });
  } finally {
    reader.disconnect();
  }
});

// Losing the Artifact with a membership: core's revokeSocketAccess closes the
// person's sockets after the removal's commit, and the rooms go with them
// (socket/objectWatch.ts); no watch outlives the removal.
for (const removal of ["channel", "server"] as const) {
  test(`removing a watcher from the Artifact's ${removal} closes their socket, rooms and all; they hear nothing more`, async ({ app, seed }) => {
    const world = await seedWorld(seed, app);
    const owner = await connect(app, world.who.owner);
    const reader = await connect(app, world.who.reader);
    // The reader's socket would reconnect by itself; asserted below on a socket of its own.
    reader.io.reconnection(false);
    let again: any = null;
    try {
      assert.equal((await watch(owner, world.page)).ok, true);
      assert.equal((await watch(reader, world.page)).ok, true);
      const readerSocketId = reader.id as string;
      assert.ok(roomsOf(app, reader).has(objectWatchRoom("artifact", world.page, "comments")));

      const closed = waitEvent(reader, "disconnect");
      const path = removal === "channel"
        ? `/api/channels/${world.room.id}/members/user/${world.who.reader.userId}`
        : `/api/servers/${world.server.id}/members/${world.who.reader.userId}`;
      const removed = await call(app, "DELETE", path, world.who.owner);
      assert.equal(removed.status, 200, removed.text);
      await closed;
      assert.equal(app.io.sockets.sockets.get(readerSocketId), undefined, "the watching socket is gone, and its rooms with it");
      assert.equal(app.io.sockets.adapter.rooms.get(objectWatchRoom("artifact", world.page, "comments"))?.has(readerSocketId) ?? false, false);

      // A comment after: the owner still hears it.
      const pinged = waitEvent<ObjectChangedEvent>(owner, OBJECT_CHANGED_EVENT);
      const posted = await call(app, "POST", artifactWebPaths.comments(world.page), world.who.owner, { body: [{ type: "text", text: "after the removal" }], version: 1, target: { scope: "artifact" }, replyTo: null });
      assert.equal(posted.status, 201, posted.text);
      assert.deepEqual(await pinged, { kind: "artifact", id: world.page, part: "comments" });

      if (removal === "channel") {
        // Connected again (still a member of the server): watching it again is refused.
        again = await connect(app, world.who.reader);
        assert.deepEqual(await watch(again, world.page), { ok: false, code: "not_visible" });
        assert.ok(![...roomsOf(app, again)].some((room) => room.startsWith("object-watch:")));
      } else {
        // Not a member of the server any more: no socket for it at all.
        again = clientIo(app.baseUrl, { auth: { token: world.who.reader.token, serverId: world.server.id }, transports: ["websocket"], autoConnect: false, reconnection: false });
        const refused = waitEvent<Error>(again, "connect_error");
        again.connect();
        assert.equal((await refused).message, SOCKET_NOT_SERVER_MEMBER_ERROR);
      }
    } finally {
      owner.disconnect();
      reader.disconnect();
      again?.disconnect();
    }
  });
}
