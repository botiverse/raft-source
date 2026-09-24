import assert from "node:assert/strict";
import { once } from "node:events";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { vi } from "vitest";
import { createApiTest } from "../test/integration/apiTest.js";
import { signAccessToken } from "../middleware/auth.js";
import { createSession, revokeAllUserSessions, revokeSession } from "../services/sessionService.js";
import * as serverService from "../services/serverService.js";
import { createSocialAuthCompletion } from "../services/socialAuthService.js";
import { userAuthIdentities } from "../db/schema.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

test("revoked access token cannot complete social identity linking", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const revoked = await createSession(owner.id);
  const oldToken = signAccessToken(owner.id, revoked.familyId);
  const code = await createSocialAuthCompletion({
    provider: "google", mode: "link", intendedAction: "link", userId: owner.id,
    providerUserId: "audit-controlled-social-identity",
    providerEmail: "audit-controlled@example.test", providerEmailVerified: true,
    returnTo: "/settings?tab=account",
  });
  await revokeAllUserSessions(owner.id);
  const complete = (token: string) => fetch(`${app.baseUrl}/api/auth/google/complete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const rejected = await complete(oldToken);
  assert.equal(rejected.status, 401);
  await rejected.json();
  assert.equal((await db.select().from(userAuthIdentities).where(eq(userAuthIdentities.userId, owner.id))).length, 0);
  // Rejection must not consume the completion; a fresh, live session can finish.
  const live = await createSession(owner.id);
  const accepted = await complete(signAccessToken(owner.id, live.familyId));
  assert.equal(accepted.status, 200);
  await accepted.json();
  const identities = await db.select().from(userAuthIdentities).where(eq(userAuthIdentities.userId, owner.id));
  assert.equal(identities.length, 1);
  assert.equal(identities[0].providerUserId, "audit-controlled-social-identity");
});

async function socketHandshake(
  baseUrl: string, token: string, serverId: string,
  connected?: (ws: WebSocket) => Promise<void>,
): Promise<string> {
  // Exercise the real Engine.IO + Socket.IO wire handshake without a fake auth middleware.
  const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`);
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Socket auth did not settle")), 5_000);
      const finish = (packet: string) => { clearTimeout(timer); resolve(packet); };
      ws.on("error", (error) => { clearTimeout(timer); reject(error); });
      ws.on("message", (data) => {
        const packet = data.toString();
        if (packet.startsWith("0")) ws.send(`40${JSON.stringify({ token, serverId })}`);
        if (packet.startsWith("40") || packet.startsWith("44")) finish(packet);
      });
    });
    if (result.startsWith("40")) await connected?.(ws);
    return result;
  } finally {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }
}

test("revoked access token cannot reconnect to server socket rooms", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const session = await createSession(owner.id);
  const token = signAccessToken(owner.id, session.familyId);
  assert.ok((await socketHandshake(app.baseUrl, token, server.id)).startsWith("40"));
  await revokeAllUserSessions(owner.id);
  const denied = await socketHandshake(app.baseUrl, token, server.id);
  assert.ok(denied.startsWith("44"), `revoked token must get CONNECT_ERROR, got ${denied}`);
});

for (const mode of ["all", "one"] as const) {
test(`revoked connected socket stops receiving user-room data: ${mode}`, async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const session = await createSession(owner.id);
  const result = await socketHandshake(app.baseUrl, signAccessToken(owner.id, session.familyId), server.id, async (ws) => {
    const events: string[] = [];
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Neither disconnect nor ordered broadcast barrier arrived")), 5_000);
      const finish = () => { clearTimeout(timer); resolve(); };
      ws.on("close", finish);
      ws.on("message", (data) => {
        const packet = data.toString();
        if (packet === "41") finish();
        if (!packet.startsWith("42")) return;
        events.push(packet);
        if (packet.includes('"audit:barrier"')) finish();
      });
    });
    if (mode === "all") await revokeAllUserSessions(owner.id);
    else await revokeSession(session.refreshToken);
    app.io.to(`user:${owner.id}`).emit("message:new", { content: "audit-private-message-after-revocation" });
    app.io.to(`user:${owner.id}`).emit("audit:barrier");
    await observed;
    assert.equal(events.some((event) => event.includes("audit-private-message-after-revocation")), false,
      "a revoked, already-connected client must not receive private broadcasts");
  });
  assert.ok(result.startsWith("40"), "control must connect before revocation");
});
}

test("revocation during Socket handshake cannot resurrect stale authorization", async ({ app, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const session = await createSession(owner.id);
  const isMember = serverService.isMember;
  const spy = vi.spyOn(serverService, "isMember").mockImplementationOnce(async (...args) => {
    const member = await isMember(...args);
    await revokeAllUserSessions(owner.id);
    return member;
  });
  try {
    const result = await socketHandshake(app.baseUrl, signAccessToken(owner.id, session.familyId), server.id);
    assert.ok(result.startsWith("44"), "stale handshake must receive CONNECT_ERROR");
  } finally {
    spy.mockRestore();
  }
});
