// Authorization lifecycle regressions: exercise real HTTP and Socket receivers.
// Synthetic DB/argon2 failures pin the race without real user credentials.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import argon2 from "argon2";
import { and, eq, DrizzleQueryError } from "drizzle-orm";
import WebSocket from "ws";
import { createApiTest } from "../test/integration/apiTest";
import { signAccessToken, verifyActiveAccessToken } from "../middleware/auth";
import * as session from "../services/sessionService";
import { accessTokenForTest, signInForTest } from "../test/integration/credentials";
import * as userService from "../services/userService";
import * as serverService from "../services/serverService";
import * as searchService from "../services/searchService";
import * as revocations from "../socket/accessRevocation";
import { ensureFamilyRevokeCapability } from "../services/pushService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { channels, featureFlagRules, passwordResets, serverMembers, sessionFamilies, users } from "../db/schema";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { seedBoundGuest } from "../test/guestFixture";
function disconnected(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Revoked socket stayed connected")), 5000);
    ws.once("close", () => { clearTimeout(timeout); resolve(); });
  });
}
const test = createApiTest();
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function post(base: string, path: string, body: object) {
  return fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
function waitPacket(ws: WebSocket, packets: string[], pattern: string) {
  if (packets.some(p => p.includes(pattern)))
    return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { clean(); reject(new Error(`No packet: ${pattern}`)); }, 5000);
    function clean() { clearTimeout(timer); ws.off("message", onMessage); ws.off("close", onClose); }
    function onMessage(data: WebSocket.RawData) {
      if (data.toString().includes(pattern)) {
        clean();
        resolve();
      }
    }
    function onClose() { clean(); reject(new Error("Socket closed before expected leakage/control")); }
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}
async function openSocket(base: string, token: string, serverId: string) {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  const packets: string[] = [];
  ws.on("message", data => {
    const p = data.toString();
    packets.push(p);
    if (p.startsWith("0"))
      ws.send(`40${JSON.stringify({ token, serverId })}`);
  });
  await waitPacket(ws, packets, '"rooms:joined"');
  return { ws, packets };
}
test("family-revoke API closes the revoked family socket", async ({ app, seed }) => {
  const human = await seed.human();
  const server = await seed.server({ owner: human });
  const auth = await signInForTest(human.id);
  const token = signAccessToken(human.id, auth.familyId);
  const cap = await ensureFamilyRevokeCapability({ userId: human.id, familyId: auth.familyId });
  assert.ok(cap);
  const { ws, packets } = await openSocket(app.baseUrl, token, server.id);
  try {
    const closed = disconnected(ws);
    const response = await post(app.baseUrl, "/api/push/family-revoke", { capability: cap });
    assert.equal(response.status, 204);
    assert.equal(await verifyActiveAccessToken(token), null, "HTTP auth correctly rejects this revoked family");
    app.io.to(`user:${human.id}`).emit("audit:private-after-capability", { content: "synthetic-private-payload" });
    await closed;
    assert.equal(packets.some(p => p.includes("synthetic-private-payload")), false);
  }
  finally {
    ws.terminate();
  }
});
test("legacy predecessor logout revokes the successor family", async ({ app, seed }) => {
  const human = await seed.human();
  const first = await signInForTest(human.id);
  const next = await session.refreshSession(first.refreshToken);
  assert.ok(next);
  const logout = await post(app.baseUrl, "/api/auth/logout", { refreshToken: first.refreshToken });
  assert.equal(logout.status, 200);
  assert.equal(await verifyActiveAccessToken(signAccessToken(human.id, next.familyId)), null);
  const replay = await session.refreshSession(first.refreshToken);
  assert.equal(replay, null);
  await session.revokeAllUserSessions(human.id);
  assert.equal(await session.refreshSession(first.refreshToken), null, "revoke-all remains a positive control");
});
test("logout lineage survives multiple rotations and a lost process replay cache", async ({ app, seed }) => {
  const human = await seed.human();
  const first = await signInForTest(human.id);
  const second = await session.refreshSession(first.refreshToken);
  assert.ok(second);
  const third = await session.refreshSession(second.refreshToken);
  assert.ok(third);
  session.__clearSessionServiceLocalReplayCacheForTests();
  assert.equal(await session.refreshSession(first.refreshToken), null);
  const logout = await post(app.baseUrl, "/api/auth/logout", { refreshToken: first.refreshToken });
  assert.equal(logout.status, 200);
  assert.equal(await verifyActiveAccessToken(signAccessToken(human.id, third.familyId)), null);
  assert.equal(await session.refreshSession(third.refreshToken), null);
});
for (const mode of ["guest-removal", "public-to-private"] as const) {
  test(`${mode} revokes both HTTP access and old socket subscription`, async ({ app, seed, db, http }) => {
    const owner = await seed.human();
    const reader = await seed.human();
    const server = await seed.server({ owner, members: [reader] });
    const channel = await seed.channel({ server, members: [owner] });
    // A Guest reads its one channel while it is a member (#wg-rbac:#15).
    if (mode === "guest-removal") await seedBoundGuest({ serverId: server.id, userId: reader.id, channelId: channel.id }, db);
    const { ws, packets } = await openSocket(app.baseUrl, await accessTokenForTest(reader.id), server.id);
    try {
      app.io.to(`channel:${channel.id}`).emit("audit:control", "visible-before-change");
      await waitPacket(ws, packets, "visible-before-change");
      const closed = disconnected(ws);
      const changed = mode === "guest-removal"
        ? await http.as(owner, server).request(`/api/channels/${channel.id}/members/user/${reader.id}`, { method: "DELETE" })
        : await http.as(owner, server).request(`/api/channels/${channel.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ visibility: "private" }) });
      assert.equal(changed.status, 200, await changed.text());
      const denied = await http.as(reader, server).get(`/api/channels/${channel.id}`);
      // A Guest removed from its channel leaves the server with it (#wg-rbac:#15).
      assert.equal(denied.status, mode === "guest-removal" ? 403 : 404);
      const sent = await http.as(owner, server).request("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: channel.id, content: `synthetic-private-after-${mode}` }) });
      assert.equal(sent.status, 200, await sent.text());
      await closed;
      assert.equal(packets.some(p => p.includes(`synthetic-private-after-${mode}`)), false);
    }
    finally {
      ws.terminate();
    }
  });
}
test("role-demotion to Guest is refused: HTTP access and the socket subscription stay", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const reader = await seed.human();
  const server = await seed.server({ owner, members: [reader] });
  const channel = await seed.channel({ server, members: [owner] });
  const { ws, packets } = await openSocket(app.baseUrl, await accessTokenForTest(reader.id), server.id);
  try {
    // Guests are invited to a channel (#wg-rbac:#15), never made from members.
    const changed = await http.as(owner, server).request(`/api/servers/${server.id}/members/${reader.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "guest" }) });
    assert.equal(changed.status, 403, await changed.text());
    assert.equal((await http.as(reader, server).get(`/api/channels/${channel.id}`)).status, 200);
    app.io.to(`channel:${channel.id}`).emit("audit:control", "visible-after-refused-demotion");
    await waitPacket(ws, packets, "visible-after-refused-demotion");
    assert.equal(ws.readyState, WebSocket.OPEN);
  }
  finally {
    ws.terminate();
  }
});
test("blast radius: channel visibility changes evict only sockets that lose access", async ({ app, seed, db, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const outsider = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [member, outsider, guest] });
  await db.insert(featureFlagRules).values({ flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
    });
  // A Guest bound to its own channel (#wg-rbac:#15); hiding another channel from guests still evicts every guest connection.
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  const channel = await seed.channel({ server, members: [owner, member] });
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
  const memberSocket = await openSocket(app.baseUrl, await accessTokenForTest(member.id), server.id);
  const guestSocket = await openSocket(app.baseUrl, await accessTokenForTest(guest.id), server.id);
  const outsiderSocket = await openSocket(app.baseUrl, await accessTokenForTest(outsider.id), server.id);
  const headers = { "Content-Type": "application/json" };
  try {
    // Hiding the channel from guests closes guest connections only.
    const guestClosed = disconnected(guestSocket.ws);
    const hidden = await http.as(owner, server).request(`/api/channels/${channel.id}`, { method: "PATCH", headers, body: JSON.stringify({ guestVisible: false }) });
    assert.equal(hidden.status, 200, await hidden.text());
    await guestClosed;
    app.io.to(`user:${member.id}`).emit("audit:control", "member-survives-guest-policy");
    await waitPacket(memberSocket.ws, memberSocket.packets, "member-survives-guest-policy");
    app.io.to(`user:${outsider.id}`).emit("audit:control", "outsider-survives-guest-policy");
    await waitPacket(outsiderSocket.ws, outsiderSocket.packets, "outsider-survives-guest-policy");

    // Converting to private closes non-member connections only.
    const outsiderClosed = disconnected(outsiderSocket.ws);
    const converted = await http.as(owner, server).request(`/api/channels/${channel.id}`, { method: "PATCH", headers, body: JSON.stringify({ visibility: "private" }) });
    assert.equal(converted.status, 200, await converted.text());
    await outsiderClosed;
    app.io.to(`user:${member.id}`).emit("audit:control", "member-survives-private-conversion");
    await waitPacket(memberSocket.ws, memberSocket.packets, "member-survives-private-conversion");
    assert.equal(memberSocket.ws.readyState, WebSocket.OPEN, "a channel member must keep its connection across both changes");
  } finally {
    for (const { ws } of [memberSocket, guestSocket, outsiderSocket]) ws.terminate();
  }
});

test("reset token can complete only one concurrent password change", async ({ app, seed, db }) => {
  const human = await seed.human();
  const token = "synthetic-reset-double-use";
  await db.insert(passwordResets).values({ userId: human.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60000) });
  const original = argon2.hash.bind(argon2);
  const firstAtHash = deferred();
  const release = deferred();
  const spy = vi.spyOn(argon2, "hash").mockImplementation(async (...args: Parameters<typeof argon2.hash>) => {
    if (args[0] === "first-reset-password") {
      firstAtHash.resolve();
      await release.promise;
    }
    return original(...args);
  });
  let first: Promise<Response> | undefined;
  try {
    first = post(app.baseUrl, "/api/auth/reset-password", { token, password: "first-reset-password" });
    await firstAtHash.promise;
    const second = await post(app.baseUrl, "/api/auth/reset-password", { token, password: "second-reset-password" });
    assert.equal(second.status, 200);
    release.resolve();
    assert.equal((await first).status, 400);
    const [row] = await db.select().from(users).where(eq(users.id, human.id));
    assert.equal(await argon2.verify(row.passwordHash, "second-reset-password"), true, "losing request cannot overwrite the successful reset");
    const third = await post(app.baseUrl, "/api/auth/reset-password", { token, password: "third-reset-password" });
    assert.equal(third.status, 400);
  }
  finally {
    release.resolve();
    await first;
    spy.mockRestore();
  }
});
for (const mode of ["reset", "change"] as const) {
  test(`old-password login in flight cannot create a family after ${mode}`, async ({ app, seed, db, http }) => {
    const human = await seed.human();
    const existing = await signInForTest(human.id);
    const token = "synthetic-reset-login-race";
    await db.insert(passwordResets).values({ userId: human.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60000) });
    const original = argon2.verify.bind(argon2);
    const verified = deferred();
    const release = deferred();
    let paused = false;
    const spy = vi.spyOn(argon2, "verify").mockImplementation(async (...args: Parameters<typeof argon2.verify>) => {
      const valid = await original(...args);
      if (!paused && args[1] === "password123") {
        paused = true;
        verified.resolve();
        await release.promise;
      }
      return valid;
    });
    let login: Promise<Response> | undefined;
    try {
      login = post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
      await verified.promise;
      const reset = mode === "reset"
        ? await post(app.baseUrl, "/api/auth/reset-password", { token, password: "new-reset-password" })
        : await http.as(human).request("/api/auth/me", {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: "password123", newPassword: "new-reset-password" }),
        });
      assert.equal(reset.status, 200);
      assert.equal(await verifyActiveAccessToken(signAccessToken(human.id, existing.familyId)), null);
      release.resolve();
      const result = await login;
      assert.equal(result.status, 401);
      const fresh = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "new-reset-password" });
      assert.equal(fresh.status, 200);
      const body = await fresh.json();
      assert.ok(await verifyActiveAccessToken(body.accessToken));
      const late = await post(app.baseUrl, "/api/auth/login", { email: human.email, password: "password123" });
      assert.equal(late.status, 401);
    }
    finally {
      release.resolve();
      await login;
      spy.mockRestore();
    }
  });
}
test("real HTTP login catch omits bound DB data from console", async ({ app }) => {
  const marker = "synthetic-sensitive-email@example.invalid";
  const error = new DrizzleQueryError("select * from users where email=$1", [marker], new Error("injected database failure"));
  const authenticate = vi.spyOn(userService, "authenticateUser").mockRejectedValueOnce(error);
  const logs = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    const res = await post(app.baseUrl, "/api/auth/login", { email: marker, password: "synthetic-password" });
    assert.equal(res.status, 500);
    assert.ok(logs.mock.calls.some(call => call[0] === "Login error:"));
    assert.equal(logs.mock.calls.some(call => inspect(call).includes(marker)), false);
    assert.ok(!inspect(serializeErrorForLog(error)).includes(marker), "safe serializer control");
    assert.ok(!(await res.text()).includes(marker), "HTTP error response does not leak");
  }
  finally {
    authenticate.mockRestore();
    logs.mockRestore();
  }
});
test("guest cannot receive hidden channel metadata via channel:updated", async ({ app, seed, db, http }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  // The guest's one channel (#wg-rbac:#15): its metadata reaches the guest.
  const visible = await seed.channel({ server, members: [owner] });
  await seedBoundGuest({ serverId: server.id, userId: guest.id, channelId: visible.id }, db);
  const { ws, packets } = await openSocket(app.baseUrl, await accessTokenForTest(guest.id), server.id);
  try {
    const created = await http.as(owner, server).request("/api/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "hidden-audit-channel", description: "synthetic-confidential-channel-description", visibility: "public" }) });
    assert.equal(created.status, 200);
    const channel = await created.json();
    const denied = await http.as(guest, server).get(`/api/channels/${channel.id}`);
    assert.equal(denied.status, 404);
    const edited = await http.as(owner, server).request(`/api/channels/${channel.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "synthetic-confidential-edited-description" }),
    });
    assert.equal(edited.status, 200);
    const permitted = await http.as(owner, server).request(`/api/channels/${visible.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "synthetic-permitted-guest-description" }),
    });
    assert.equal(permitted.status, 200);
    await waitPacket(ws, packets, "synthetic-permitted-guest-description");
    app.io.to(`user:${guest.id}`).emit("audit:metadata-barrier");
    await waitPacket(ws, packets, "audit:metadata-barrier");
    assert.equal(packets.some(p => p.includes("synthetic-confidential-channel-description")), false);
    assert.equal(packets.some(p => p.includes("synthetic-confidential-edited-description")), false);
  }
  finally {
    ws.terminate();
  }
});
test("regression: existing member socket receives tasks in a newly created public channel", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const member = await seed.human();
  const server = await seed.server({ owner, members: [member] });
  const { ws, packets } = await openSocket(app.baseUrl, await accessTokenForTest(member.id), server.id);
  try {
    const created = await http.as(owner, server).request("/api/channels", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "audit-new-public", visibility: "public" }) });
    assert.equal(created.status, 200);
    const channel = await created.json();
    await waitPacket(ws, packets, channel.id);
    assert.equal((await http.as(member, server).get(`/api/channels/${channel.id}`)).status, 200);
    const createTask = async (title: string) => {
      const response = await http.as(owner, server).request(`/api/tasks/channel/${channel.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tasks: [{ title }] }) });
      assert.equal(response.status, 200, await response.text());
    };
    await createTask("synthetic-missing-task-event");
    app.io.to(`user:${member.id}`).emit("audit:task-barrier", "barrier-after-task");
    await waitPacket(ws, packets, "barrier-after-task");
    assert.equal(packets.some(p => p.includes('"task:created"') && p.includes("synthetic-missing-task-event")), true);
    const connected = packets.find(p => p.startsWith("40"));
    assert.ok(connected);
    const socket = app.io.of("/").sockets.get(JSON.parse(connected.slice(2)).sid);
    assert.ok(socket);
    const handler = socket.listeners("join:channel")[0];
    socket.off("join:channel", handler);
    const joined = new Promise<void>((resolve, reject) => socket.once("join:channel", async (...args) => {
      try {
        await handler(...args);
        resolve();
      }
      catch (e) {
        reject(e);
      }
    }));
    ws.send(`42${JSON.stringify(["join:channel", channel.id])}`);
    await joined;
    await createTask("synthetic-joined-task-control");
    await waitPacket(ws, packets, "synthetic-joined-task-control");
    assert.ok(packets.some(p => p.includes('"task:created"') && p.includes("synthetic-joined-task-control")));
  }
  finally {
    ws.terminate();
  }
});
test("regression: another user's logout preserves a valid in-flight handshake", async ({ app, seed }) => {
  const owner = await seed.human();
  const other = await seed.human();
  const server = await seed.server({ owner });
  const live = await signInForTest(owner.id);
  const token = signAccessToken(owner.id, live.familyId);
  const original = serverService.isMember;
  const spy = vi.spyOn(serverService, "isMember").mockImplementationOnce(async (...args) => {
    const result = await original(...args);
    await session.revokeAllUserSessions(other.id);
    return result;
  });
  const ws = new WebSocket(`${app.baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  const result = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Handshake did not settle")), 5000);
    ws.on("message", data => {
      const p = data.toString();
      if (p.startsWith("0"))
        ws.send(`40${JSON.stringify({ token, serverId: server.id })}`);
      if (p.startsWith("40") || p.startsWith("44")) {
        clearTimeout(timeout);
        resolve(p);
      }
    });
  });
  try {
    const packet = await result;
    assert.ok(packet.startsWith("40"), `unrelated revocation rejected valid handshake: ${packet}`);
    assert.ok(await verifyActiveAccessToken(token));
    spy.mockRestore();
    const retry = await openSocket(app.baseUrl, token, server.id);
    retry.ws.terminate();
  }
  finally {
    spy.mockRestore();
    ws.terminate();
  }
});
test("positive control: actual HTTP search catch drops bound DB parameters", async ({ seed, http }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const marker = "synthetic-private-search-parameter";
  const error = new DrizzleQueryError("select * from messages where content=$1", [marker], new Error("injected database failure"));
  const search = vi.spyOn(searchService, "searchMessagesForUser").mockRejectedValueOnce(error);
  const logs = vi.spyOn(console, "error").mockImplementation(() => { });
  try {
    const result = await http.as(owner, server).get(`/api/messages/search?q=${marker}`);
    assert.equal(result.status, 500);
    const calls = logs.mock.calls.filter(call => call[0] === "Search messages error:");
    assert.equal(calls.length, 1);
    assert.ok(inspect(calls).includes("Database query failed"));
    assert.ok(!inspect(calls).includes(marker));
    assert.ok(!(await result.text()).includes(marker));
  }
  finally {
    search.mockRestore();
    logs.mockRestore();
  }
});
for (const mode of ["visibility", "role", "logout", "capability"] as const) {
  test(`post-commit ${mode} retry repairs a failed socket revocation`, async ({ app, seed, db, http }) => {
    const owner = await seed.human();
    const reader = await seed.human();
    const server = await seed.server({ owner, members: [reader] });
    const channel = await seed.channel({ server, members: [owner] });
    // A role change revokes sockets: an admin demoted to member (no one becomes a Guest, #wg-rbac:#15).
    if (mode === "role") await db.update(serverMembers).set({ role: "admin" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, reader.id)));
    const live = await signInForTest(reader.id);
    const capability = await ensureFamilyRevokeCapability({ userId: reader.id, familyId: live.familyId });
    const { ws } = await openSocket(app.baseUrl, signAccessToken(reader.id, live.familyId), server.id);
    const request = () => {
      if (mode === "logout")
        return post(app.baseUrl, "/api/auth/logout", { refreshToken: live.refreshToken });
      if (mode === "capability")
        return post(app.baseUrl, "/api/push/family-revoke", { capability });
      return http.as(owner, server).request(mode === "role"
        ? `/api/servers/${server.id}/members/${reader.id}` : `/api/channels/${channel.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "role" ? { role: "member" } : { visibility: "private" }),
      });
    };
    const unavailable = vi.spyOn(revocations, "revokeSocketAccess")
      .mockRejectedValueOnce(new Error("synthetic peer unavailable after commit"));
    try {
      assert.equal((await request()).status, 500);
      assert.equal(ws.readyState, WebSocket.OPEN);
      unavailable.mockRestore();
      const closed = disconnected(ws);
      assert.equal((await request()).status, mode === "capability" ? 204 : 200);
      await closed;
    }
    finally {
      unavailable.mockRestore();
      ws.terminate();
    }
  });
}
test("member removal tells the removed connection before closing it, and only that server's connection", async ({ app, seed, http }) => {
  const owner = await seed.human();
  const removed = await seed.human();
  const server = await seed.server({ owner, members: [removed] });
  const otherServer = await seed.server({ owner, members: [removed] });
  const channel = await seed.channel({ server, members: [owner, removed] });
  const removedSocket = await openSocket(app.baseUrl, await accessTokenForTest(removed.id), server.id);
  const otherSocket = await openSocket(app.baseUrl, await accessTokenForTest(removed.id), otherServer.id);
  try {
    const removedClosed = disconnected(removedSocket.ws);
    const otherClosed = disconnected(otherSocket.ws);
    const res = await http.as(owner, server).request(`/api/servers/${server.id}/members/${removed.id}`, { method: "DELETE" });
    assert.equal(res.status, 200, await res.text());
    const sent = await http.as(owner, server).request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: channel.id, content: "synthetic-after-member-removal" }),
    });
    assert.equal(sent.status, 200, await sent.text());
    await Promise.all([removedClosed, otherClosed]);

    const notice = `42["server:membership-removed",{"serverId":"${server.id}"}]`;
    assert.equal(removedSocket.packets.at(-1), notice, "the removal notice is the last packet before close");
    assert.equal(otherSocket.packets.some((p) => p.includes("server:membership-removed")), false);
    assert.equal(removedSocket.packets.some((p) => p.includes("synthetic-after-member-removal")), false);
  } finally {
    removedSocket.ws.terminate();
    otherSocket.ws.terminate();
  }
});
